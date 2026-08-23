const {definePlugin} = require('trek-plugin-sdk');

const GEOCODE_TIMEOUT_MS = 5000;

// --- Ranking model -------------------------------------------------------
// Displayed score is the plain average of what people said. RANKING uses a
// mean shrunk toward the neutral point, so an activity has to earn its votes
// to climb: a 5.0 from one person sits below a 4.5 from six. RANK_WEIGHT is
// how many neutral votes every activity starts with.
const RANK_PRIOR = 3;
const RANK_WEIGHT = 2;

// A ballot is "split" when the group genuinely disagrees — someone is keen
// AND someone would rather not. That is the signal worth surfacing; a single
// agreement percentage conflates disagreement with a low turnout.
const SPLIT_HIGH = 4;
const SPLIT_LOW = 2;

const SORTS = ['pick', 'votes', 'new', 'split'];

function json(status, obj) {
    return {
        status,
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(obj)
    };
}

function toNum(v, fb) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : fb;
}

async function readBody(req) {
    let b = req.body;
    if (typeof b === 'string') {
        try {
            b = JSON.parse(b);
        } catch (_) {
            b = {};
        }
    }
    return b && typeof b === 'object' ? b : {};
}

// An error carrying an HTTP status, understood by wrapHandler.
function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

function wrapHandler(fn) {
    return async function (req, ctx) {
        try {
            return await fn(req, ctx);
        } catch (e) {
            const status = e && e.status ? e.status : 500;
            if (status >= 500) ctx.log.error('route error', {
                path: req.path,
                msg: String(e && e.message),
                stack: e && e.stack
            });
            return json(status, {error: (e && e.message) || 'error'});
        }
    };
}

/**
 * The authorization gate for every trip-scoped route.
 *
 * The plugin's own database is not protected by the host: any authenticated
 * user can send an arbitrary tripId. ctx.trips.getById, however, is
 * membership-checked host-side against the requesting user — so a successful
 * read IS the proof that this user may see this trip's Vox data. Every
 * trip-scoped route must come through here BEFORE touching ctx.db.
 */
async function assertTripAccess(ctx, tripId) {
    const id = toNum(tripId, null);
    if (!id) throw httpError(400, 'Trip ID is required');
    let trip;
    try {
        trip = await ctx.trips.getById(id);
    } catch (e) {
        ctx.log.warn('Trip access refused', {tripId: id, code: e && e.code, error: e && e.message});
        throw httpError(403, 'Trip not accessible');
    }
    if (!trip) throw httpError(403, 'Trip not accessible');
    // The full trips row, so a caller that needs the owner (trips.user_id)
    // does not have to read it again.
    return {...trip, id: id};
}

/** Load an activity and check the caller has access to ITS trip. */
async function loadActivityForUser(ctx, activityId) {
    const id = toNum(activityId, null);
    if (!id) throw httpError(400, 'activityId required');
    const rows = await ctx.db.query('SELECT * FROM activities WHERE id = ?', [id]);
    if (!rows.length) throw httpError(404, 'Activity not found');
    const trip = await assertTripAccess(ctx, rows[0].trip_id);
    return {activity: rows[0], trip: trip};
}

/** An area can only be attached to an activity of the same trip. */
async function resolveAreaInTrip(ctx, areaId, tripId) {
    const id = toNum(areaId, null);
    if (!id) return null;
    const rows = await ctx.db.query('SELECT id FROM places WHERE id = ? AND trip_id = ?', [id, tripId]);
    if (!rows.length) throw httpError(400, 'Area does not belong to this trip');
    return id;
}

/**
 * The trip roster, or null when the host cannot answer.
 *
 * ctx.trips.getById returns the raw trips row and carries NO members array;
 * the roster only comes from ctx.trips.members(), which rides on the same
 * db:read:trips permission. An empty roster and an unknown roster are kept
 * distinct — callers draw different conclusions from them.
 */
async function getRoster(ctx, trip) {
    const tripId = trip && trip.id;
    if (!tripId) return null;

    let members;
    try {
        const raw = await ctx.trips.members(tripId);
        if (!Array.isArray(raw)) return null;
        members = raw.map(m => ({
            id: String(m && m.id),
            name: (m && (m.display_name || m.username)) || String(m && m.id),
            avatar: (m && m.avatar) || null
        }));
    } catch (e) {
        ctx.log.warn('Could not read trip roster', {tripId, error: e && e.message});
        return null;
    }

    // ctx.trips.members() reads trip_members, and TREK deliberately never puts
    // the owner in that table — tripService refuses ("Trip owner is already a
    // member") and tripMembership says so outright ("the owner already has full
    // access; never add them as a member"). So the host's roster ALWAYS omits
    // them, and without this union every count is short by one: participation
    // is inflated, the owner never shows up in "waiting on…", their own vote
    // renders as "Former member", and mayDelete mistakes them for someone who
    // left — which would let any member delete the owner's proposals.
    const ownerId = trip.user_id != null ? String(trip.user_id) : null;
    if (ownerId && !members.some(m => m.id === ownerId)) {
        members.unshift({id: ownerId, name: await resolveName(ctx, ownerId), avatar: null});
    }
    return members;
}

/** The owner is not in the roster, so their name has to be looked up. The host
 *  allows it: canSeeUser counts owner-or-member on both sides. */
async function resolveName(ctx, userId) {
    try {
        const u = await ctx.users.getById(parseInt(userId, 10));
        return (u && (u.display_name || u.username)) || 'Trip owner';
    } catch (e) {
        ctx.log.warn('Could not resolve the trip owner name', {userId, error: e && e.message});
        return 'Trip owner';
    }
}

function rosterIds(roster) {
    return roster ? new Set(roster.map(m => m.id)) : null;
}

/**
 * Who may withdraw a proposal.
 *
 * 1. The trip owner: they have every right over their own trip.
 * 2. The author: deleting also destroys every vote cast on it, so plain
 *    access to the trip is not enough — but withdrawing your own is.
 * 3. Any member, when the author has left the trip: without this an orphaned
 *    proposal would be undeletable by everyone.
 *
 * Unknown roster => rules 1 and 2 only. A delete right is never guessed.
 */
function mayDelete(activity, actingUserId, trip, memberIds) {
    if (trip && trip.user_id != null && String(trip.user_id) === String(actingUserId)) return true;
    if (String(activity.created_by) === String(actingUserId)) return true;
    if (!memberIds) return false;
    return !memberIds.has(String(activity.created_by));
}

function rankScore(voteCount, avg) {
    return (voteCount * avg + RANK_WEIGHT * RANK_PRIOR) / (voteCount + RANK_WEIGHT);
}

function isSplit(scores) {
    return scores.some(s => s >= SPLIT_HIGH) && scores.some(s => s <= SPLIT_LOW);
}

/** Population variance — how far apart the group is, for the "divided" sort. */
function spread(scores) {
    if (scores.length < 2) return 0;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    return scores.reduce((acc, s) => acc + (s - avg) * (s - avg), 0) / scores.length;
}

/**
 * Parse the "score:userId" pairs GROUP_CONCAT builds for one activity.
 * A score is a single digit, so the first colon always separates the two.
 * This is what replaces one /votes request per activity.
 */
function parseBallot(concatenated) {
    if (!concatenated) return [];
    return String(concatenated).split(',').reduce((acc, pair) => {
        const cut = pair.indexOf(':');
        if (cut < 1) return acc;
        const score = toNum(pair.slice(0, cut), null);
        const userId = pair.slice(cut + 1);
        if (score != null && userId) acc.push({user_id: userId, score: score});
        return acc;
    }, []);
}

/**
 * Nominatim lookup. Shared by the /geocode route and create-trek-activity:
 * there is no ctx.call(), so a route cannot invoke another route.
 * Never rejects — geocoding is optional and must not block anything.
 */
async function geocode(ctx, address) {
    const q = String(address == null ? '' : address).trim();
    if (!q) return {success: false, error: 'Address is required'};

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
    try {
        const url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) + '&format=json&limit=1';
        const response = await fetch(url, {
            headers: {'User-Agent': 'Trek-Vox-Plugin/2.0'},
            signal: controller.signal
        });

        if (!response.ok) {
            ctx.log.warn('Geocoding API error', {status: response.status});
            return {success: false, error: 'Search failed (' + response.status + ')'};
        }

        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) {
            const hit = data[0];
            return {
                success: true,
                lat: parseFloat(hit.lat),
                lng: parseFloat(hit.lon),
                address: hit.display_name || q
            };
        }

        return {success: false, error: 'No match found', address: q};
    } catch (e) {
        const aborted = e && e.name === 'AbortError';
        ctx.log.warn('Geocoding failed', {error: e && e.message, address: q});
        return {success: false, error: aborted ? 'Search timed out' : 'Search unavailable'};
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Drop trek_place_id for activities whose TREK place is gone (deleted from the
 * itinerary by hand). One read of the trip's place pool — the previous version
 * probed each one with a places.update(..., {}), a TREK WRITE per activity on
 * every page load, recorded in the capability audit log.
 */
async function reconcileTrekLinks(ctx, tripId, activities) {
    const linked = activities.filter(a => a.trek_place_id != null);
    if (!linked.length) return activities;

    let alive;
    try {
        const places = await ctx.trips.getPlaces(tripId);
        alive = new Set((places || []).map(p => String(p.id)));
    } catch (e) {
        // Cannot tell: leave every link alone rather than unlinking blindly.
        ctx.log.warn('Could not read trip places', {tripId, error: e && e.message});
        return activities;
    }

    const orphaned = linked.filter(a => !alive.has(String(a.trek_place_id)));
    for (const a of orphaned) {
        await ctx.db.exec('UPDATE activities SET trek_place_id = NULL WHERE id = ?', [a.id]);
        a.trek_place_id = null;
        ctx.log.info('Unlinked an activity whose TREK place is gone', {activityId: a.id});
    }
    return activities;
}

const routes = [
    // ===== GET /board?tripId=N[&sort=pick|votes|new|split] ==================
    // Everything one screen needs, in one request. This replaces the 4 + N
    // round-trips the old client made (one /votes call per activity).
    {
        method: 'GET',
        path: '/board',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const trip = await assertTripAccess(ctx, req.query && req.query.tripId);
            const tripId = trip.id;
            const sort = SORTS.indexOf(req.query && req.query.sort) >= 0 ? req.query.sort : 'pick';
            const me = String(req.user.id);

            const roster = await getRoster(ctx, trip);
            const memberIds = rosterIds(roster);

            const areas = await ctx.db.query(
                'SELECT id, name FROM places WHERE trip_id = ? ORDER BY name ASC',
                [tripId]
            );

            const rows = await ctx.db.query(
                `SELECT a.id, a.title, a.description, a.url, a.place_id, a.created_by,
                        a.created_at, a.trek_place_id,
                        COUNT(v.user_id) AS vote_count,
                        AVG(v.score) AS avg_score,
                        GROUP_CONCAT(v.score || ':' || v.user_id) AS ballot
                 FROM activities a
                 LEFT JOIN votes v ON v.activity_id = a.id
                 WHERE a.trip_id = ?
                 GROUP BY a.id`,
                [tripId]
            );

            await reconcileTrekLinks(ctx, tripId, rows);

            // One request carries the whole board, which is what makes search,
            // the filter lenses and sorting instant with no round trip. That
            // only stays true if a row is lean: anything the client can derive
            // from `members` and `areas` is NOT repeated per activity — no
            // voter names, no absentee list, no area name. At 500 proposals and
            // a dozen members that is the difference between ~480 KB and half
            // of it.
            const activities = rows.map(row => {
                const ballot = parseBallot(row.ballot);
                const scores = ballot.map(b => b.score);
                const voteCount = scores.length;
                const avg = voteCount ? scores.reduce((a, b) => a + b, 0) / voteCount : null;
                const mine = ballot.find(b => b.user_id === me);

                return {
                    id: row.id,
                    title: row.title,
                    description: row.description || '',
                    url: row.url || '',
                    area_id: row.place_id,
                    created_at: row.created_at,
                    trek_place_id: row.trek_place_id,
                    can_delete: mayDelete(row, req.user.id, trip, memberIds),
                    vote_count: voteCount,
                    avg_score: avg,
                    rank_score: rankScore(voteCount, avg == null ? RANK_PRIOR : avg),
                    split: isSplit(scores),
                    my_score: mine ? mine.score : null,
                    // { u: userId, s: score } — the client resolves names and
                    // works out who is missing.
                    ballot: ballot.map(b => ({u: b.user_id, s: b.score})),
                    // Sort keys only, never rendered.
                    _spread: spread(scores)
                };
            });

            const comparators = {
                pick: (a, b) => b.rank_score - a.rank_score || b.vote_count - a.vote_count,
                votes: (a, b) => b.vote_count - a.vote_count || b.rank_score - a.rank_score,
                new: (a, b) => (b.created_at || 0) - (a.created_at || 0),
                split: (a, b) => b._spread - a._spread || b.vote_count - a.vote_count
            };

            const deciding = activities.filter(a => a.trek_place_id == null).sort(comparators[sort]);
            const inTrip = activities.filter(a => a.trek_place_id != null).sort(comparators.pick);

            // The sort keys have done their job; they never reach the wire.
            activities.forEach(a => { delete a._spread; });

            return json(200, {
                trip_id: tripId,
                sort: sort,
                my_user_id: me,
                is_trip_owner: trip.user_id != null && String(trip.user_id) === me,
                // The one place names live. Every ballot below is ids only.
                members: roster || [],
                member_count: roster ? roster.length : 0,
                // The one place area names live, likewise.
                areas: areas.map(a => ({id: a.id, name: a.name})),
                pending_for_me: deciding.filter(a => a.my_score == null).length,
                deciding: deciding,
                in_trip: inTrip
            });
        })
    },

    // ===== POST /vote ======================================================
    {
        method: 'POST',
        path: '/vote',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const body = await readBody(req);
            const score = toNum(body.score, null);

            if (score == null || !Number.isInteger(score) || score < 1 || score > 5) {
                return json(400, {error: 'A whole score from 1 to 5 is required'});
            }

            const {activity, trip} = await loadActivityForUser(ctx, body.activityId);

            ctx.log.info('Recording vote', {activityId: activity.id, score, userId: req.user.id});

            await ctx.db.exec(
                `INSERT INTO votes (activity_id, user_id, score, updated_at)
                 VALUES (?, ?, ?, unixepoch())
                 ON CONFLICT(activity_id, user_id) DO UPDATE SET
                     score = excluded.score,
                     updated_at = excluded.updated_at`,
                [activity.id, String(req.user.id), score]
            );

            // Just enough for the client to reconcile the one card it painted
            // optimistically — the full board is not refetched on every vote.
            // Same lean shape as a /board row, so the client rehydrates it with
            // the very same code.
            const rows = await ctx.db.query(
                'SELECT GROUP_CONCAT(score || \':\' || user_id) AS ballot FROM votes WHERE activity_id = ?',
                [activity.id]
            );
            const ballot = parseBallot(rows[0] && rows[0].ballot);
            const scores = ballot.map(b => b.score);
            const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
            const roster = await getRoster(ctx, trip);

            return json(200, {
                activity_id: activity.id,
                my_score: score,
                vote_count: scores.length,
                avg_score: avg,
                rank_score: rankScore(scores.length, avg == null ? RANK_PRIOR : avg),
                split: isSplit(scores),
                ballot: ballot.map(b => ({u: b.user_id, s: b.score})),
                member_count: roster ? roster.length : 0
            });
        })
    },

    // ===== POST /activities ================================================
    {
        method: 'POST',
        path: '/activities',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const body = await readBody(req);
            const title = String(body.title == null ? '' : body.title).trim();

            if (!title) return json(400, {error: 'A title is required'});

            const tripId = (await assertTripAccess(ctx, body.trip_id)).id;
            const areaId = await resolveAreaInTrip(ctx, body.area_id, tripId);

            ctx.log.info('Creating activity', {title, tripId, userId: req.user.id, areaId});

            const result = await ctx.db.query(
                `INSERT INTO activities (title, description, url, created_by, place_id, trip_id)
                 VALUES (?, ?, ?, ?, ?, ?)
                 RETURNING *`,
                [title, body.description || '', body.url || '', String(req.user.id), areaId, tripId]
            );

            return json(201, result[0]);
        })
    },

    // ===== PUT /activities =================================================
    {
        method: 'PUT',
        path: '/activities',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const body = await readBody(req);
            const title = String(body.title == null ? '' : body.title).trim();

            if (!title) return json(400, {error: 'A title is required'});

            // Loads the activity AND checks access to its trip
            const {activity} = await loadActivityForUser(ctx, body.id);
            const tripId = activity.trip_id;

            // An activity never changes trip: a different trip_id in the body
            // would be a way to move votes out of the trip they belong to.
            if (body.trip_id != null && toNum(body.trip_id, null) !== tripId) {
                throw httpError(400, 'An activity cannot be moved to another trip');
            }

            const newAreaId = await resolveAreaInTrip(ctx, body.area_id, tripId);

            ctx.log.info('Updating activity', {activityId: activity.id, userId: req.user.id});

            await ctx.db.exec(
                `UPDATE activities
                 SET title = ?, description = ?, url = ?, place_id = ?
                 WHERE id = ?`,
                [title, body.description || '', body.url || '', newAreaId, activity.id]
            );

            await dropAreaIfUnused(ctx, activity.place_id, newAreaId);

            const updated = await ctx.db.query('SELECT * FROM activities WHERE id = ?', [activity.id]);
            return json(200, updated[0]);
        })
    },

    // ===== DELETE /activities?id=N =========================================
    {
        method: 'DELETE',
        path: '/activities',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const {activity, trip} = await loadActivityForUser(ctx, req.query && req.query.id);

            // Editing stays open to every member; deleting does not — it also
            // destroys every vote cast. See mayDelete().
            const memberIds = rosterIds(await getRoster(ctx, trip));
            if (!mayDelete(activity, req.user.id, trip, memberIds)) {
                throw httpError(403, 'Only the member who proposed this, or the trip owner, can remove it');
            }

            ctx.log.info('Deleting activity', {activityId: activity.id, userId: req.user.id});

            await ctx.db.exec('DELETE FROM votes WHERE activity_id = ?', [activity.id]);
            await ctx.db.exec('DELETE FROM activities WHERE id = ?', [activity.id]);
            await dropAreaIfUnused(ctx, activity.place_id, null);

            return json(200, {deleted: true, id: activity.id});
        })
    },

    // ===== POST /areas =====================================================
    // An "area" is a Vox grouping label (Kyoto, Day 3). It has no coordinates
    // and is NOT a TREK place — the table is still called `places` for
    // schema-compatibility reasons only.
    {
        method: 'POST',
        path: '/areas',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const body = await readBody(req);
            const name = String(body.name == null ? '' : body.name).trim();

            if (!name) return json(400, {error: 'An area name is required'});

            const tripId = (await assertTripAccess(ctx, body.trip_id)).id;

            ctx.log.info('Creating area', {name, tripId, userId: req.user.id});

            try {
                const result = await ctx.db.query(
                    `INSERT INTO places (name, created_by, trip_id, created_at)
                     VALUES (?, ?, ?, unixepoch())
                     RETURNING *`,
                    [name, String(req.user.id), tripId]
                );
                return json(201, {id: result[0].id, name: result[0].name});
            } catch (e) {
                if (e.message && e.message.includes('UNIQUE constraint failed')) {
                    // Not an error from the user's side: hand back the one that
                    // already exists so the picker can just select it.
                    const existing = await ctx.db.query(
                        'SELECT id, name FROM places WHERE name = ? AND trip_id = ?',
                        [name, tripId]
                    );
                    if (existing.length) return json(200, {id: existing[0].id, name: existing[0].name});
                }
                throw e;
            }
        })
    },

    // ===== POST /add-to-trip ===============================================
    // Turns a Vox activity into a real place in the TREK itinerary.
    {
        method: 'POST',
        path: '/add-to-trip',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const body = await readBody(req);
            const {activity} = await loadActivityForUser(ctx, body.activityId);
            const tripId = activity.trip_id;

            if (activity.trek_place_id != null) {
                return json(409, {error: 'This activity is already in the trip'});
            }

            const name = String(body.name == null ? '' : body.name).trim() || activity.title;
            const address = String(body.address == null ? '' : body.address).trim();
            let lat = toNum(body.lat, null);
            let lng = toNum(body.lng, null);

            // Best-effort geocoding: never blocks the write.
            let geocoded = false;
            if (address && lat == null && lng == null) {
                const hit = await geocode(ctx, address);
                if (hit.success) {
                    lat = hit.lat;
                    lng = hit.lng;
                    geocoded = true;
                } else {
                    ctx.log.warn('Geocoding missed, adding without coordinates', {address, error: hit.error});
                }
            }

            const placeData = {
                name: name,
                address: address,
                lat: lat,
                lng: lng,
                website: String(body.url == null ? '' : body.url).trim() || activity.url || '',
                category_id: 6,
                place_time: '',
                end_time: '',
                notes: String(body.notes == null ? '' : body.notes).trim() || ('From Vox: ' + activity.title),
                transport_mode: 'walking'
            };

            let placeId = null;
            try {
                const created = await ctx.places.create(tripId, placeData);
                placeId = created && created.id;
            } catch (e) {
                if (e.message && e.message.includes('UNIQUE constraint failed')) {
                    // A place of that name is already in the itinerary: link to
                    // it and refresh it rather than failing in the user's face.
                    // Reading a trip's places is ctx.trips.getPlaces —
                    // ctx.places only exposes create/update/delete.
                    const places = await ctx.trips.getPlaces(tripId);
                    const match = (places || []).find(p =>
                        String(p.name).toLowerCase() === placeData.name.toLowerCase()
                    );
                    if (match) {
                        const updated = await ctx.places.update(tripId, match.id, placeData);
                        placeId = (updated && updated.id) || match.id;
                    }
                } else {
                    throw e;
                }
            }

            if (!placeId) throw httpError(502, 'TREK did not accept the place');

            await ctx.db.exec('UPDATE activities SET trek_place_id = ? WHERE id = ?', [placeId, activity.id]);
            ctx.log.info('Activity added to the trip', {activityId: activity.id, placeId});

            return json(200, {
                activity_id: activity.id,
                trek_place_id: placeId,
                geocoded: geocoded,
                has_coordinates: lat != null && lng != null
            });
        })
    },

    // There is deliberately no route that undoes /add-to-trip. The itinerary is
    // the source of truth: delete the place there, and reconcileTrekLinks drops
    // the link on the next /board, putting the proposal back up for decision on
    // its own. One way for a thing to happen beats two.

    // ===== GET /geocode?address=... ========================================
    {
        method: 'GET',
        path: '/geocode',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const address = req.query && req.query.address ? String(req.query.address) : '';
            if (!address.trim()) return json(400, {error: 'An address is required'});
            return json(200, await geocode(ctx, address));
        })
    }
];

/**
 * Areas are throwaway labels, not entities the user manages: once the last
 * activity leaves one, it should stop cluttering the picker. Called after an
 * edit or a delete, never on its own.
 */
async function dropAreaIfUnused(ctx, oldAreaId, newAreaId) {
    if (!oldAreaId || oldAreaId === newAreaId) return;
    const remaining = await ctx.db.query(
        'SELECT COUNT(*) AS count FROM activities WHERE place_id = ?',
        [oldAreaId]
    );
    if (remaining[0] && remaining[0].count === 0) {
        ctx.log.info('Dropping an area with no activities left', {areaId: oldAreaId});
        await ctx.db.exec('DELETE FROM places WHERE id = ?', [oldAreaId]);
    }
}

module.exports = definePlugin({
    async onLoad(ctx) {
        ctx.log.info('Vox plugin loading...');

        await ctx.db.migrate('001_init', `
            CREATE TABLE IF NOT EXISTS activities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT,
                url TEXT,
                created_by TEXT NOT NULL,
                place_id INTEGER,
                trip_id INTEGER NOT NULL,
                created_at INTEGER DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS votes (
                activity_id INTEGER NOT NULL,
                user_id TEXT NOT NULL,
                score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
                updated_at INTEGER DEFAULT (unixepoch()),
                PRIMARY KEY (activity_id, user_id),
                FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS places (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_by TEXT NOT NULL,
                trip_id INTEGER NOT NULL,
                created_at INTEGER DEFAULT (unixepoch()),
                UNIQUE(name, trip_id)
            );

            CREATE INDEX IF NOT EXISTS idx_votes_activity ON votes(activity_id);
            CREATE INDEX IF NOT EXISTS idx_votes_user ON votes(user_id);
            CREATE INDEX IF NOT EXISTS idx_activities_place ON activities(place_id);
            CREATE INDEX IF NOT EXISTS idx_activities_trip ON activities(trip_id);
            CREATE INDEX IF NOT EXISTS idx_places_trip ON places(trip_id);
        `);

        await ctx.db.migrate('002_add_trip_members', `
            CREATE TABLE IF NOT EXISTS trip_members (
                trip_id INTEGER NOT NULL,
                user_id TEXT NOT NULL,
                joined_at INTEGER DEFAULT (unixepoch()),
                is_active BOOLEAN DEFAULT 1,
                PRIMARY KEY (trip_id, user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_trip_members_trip ON trip_members(trip_id);
            CREATE INDEX IF NOT EXISTS idx_trip_members_user ON trip_members(user_id);
        `);

        await ctx.db.migrate('003_add_trek_place_id', `
            ALTER TABLE activities ADD COLUMN trek_place_id INTEGER;
        `);

        ctx.log.info('Vox plugin loaded successfully');
    },

    async onUnload(ctx) {
        ctx.log.info('Vox plugin unloading');
    },

    routes: routes
});
