const {definePlugin} = require('trek-plugin-sdk');

const GEOCODE_TIMEOUT_MS = 5000;

// Helper pour les réponses JSON
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

function getActivityIdFromQuery(req) {
    const raw = req.query && (req.query.activityId != null ? req.query.activityId : req.query.activity_id);
    return toNum(raw, null);
}

// Erreur porteuse d'un status HTTP, reconnue par wrapHandler
function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
}

// Helper pour wrapper les handlers avec gestion d'erreurs
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
 * Le garde-fou d'autorisation de toute route liée à un voyage.
 *
 * La base du plugin n'est pas protégée par l'hôte : n'importe quel utilisateur
 * authentifié peut envoyer un tripId arbitraire. En revanche ctx.trips.getById
 * est membership-checked côté hôte contre l'utilisateur de la requête — donc une
 * lecture réussie EST la preuve que cet utilisateur a le droit de voir les
 * données Vox de ce voyage. Toute route scopée à un trip doit passer par ici
 * AVANT de toucher ctx.db.
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
    // La ligne trips complète, pour que l'appelant qui a besoin du propriétaire
    // (trips.user_id) n'ait pas à refaire la lecture.
    return {...trip, id: id};
}

/** Charge une activité et vérifie que l'appelant a accès à SON voyage. */
async function loadActivityForUser(ctx, activityId) {
    const id = toNum(activityId, null);
    if (!id) throw httpError(400, 'activityId required');
    const rows = await ctx.db.query('SELECT * FROM activities WHERE id = ?', [id]);
    if (!rows.length) throw httpError(404, 'Activity not found');
    const trip = await assertTripAccess(ctx, rows[0].trip_id);
    return {activity: rows[0], trip: trip};
}

/** Un lieu Vox ne peut être rattaché qu'à une activité du même voyage. */
async function resolvePlaceInTrip(ctx, placeId, tripId) {
    const id = toNum(placeId, null);
    if (!id) return null;
    const rows = await ctx.db.query('SELECT id FROM places WHERE id = ? AND trip_id = ?', [id, tripId]);
    if (!rows.length) throw httpError(400, 'Place does not belong to this trip');
    return id;
}

/**
 * Les ids des membres du voyage, en Set de String — ou null si l'hôte ne sait
 * pas répondre.
 *
 * ctx.trips.getById renvoie la ligne `trips` brute (SELECT * FROM trips) : elle
 * ne porte AUCUN tableau `members`. Le roster s'obtient uniquement via
 * ctx.trips.members(), qui roule sur la même permission db:read:trips.
 * On distingue « roster vide » de « roster inconnu » : les appelants n'en
 * tirent pas les mêmes conclusions.
 */
async function getTripMemberIds(ctx, tripId) {
    if (!tripId) return null;
    try {
        const roster = await ctx.trips.members(tripId);
        if (!Array.isArray(roster)) return null;
        return new Set(roster.map(m => String(m && m.id)));
    } catch (e) {
        ctx.log.warn('Could not read trip roster', {tripId, error: e && e.message});
        return null;
    }
}

/** Retourne 0 si l'effectif est inconnu — l'appelant expose alors une
 *  participation inconnue plutôt qu'un pourcentage inventé. */
async function getTripMemberCount(ctx, tripId) {
    const ids = await getTripMemberIds(ctx, tripId);
    return ids ? ids.size : 0;
}

/**
 * Qui peut retirer une proposition.
 *
 * 1. Le créateur du voyage : il a tous les droits sur son voyage.
 * 2. L'auteur de la proposition : une suppression emporte aussi tous les votes
 *    reçus, donc le simple accès au voyage ne suffit pas — mais retirer sa
 *    propre proposition, oui.
 * 3. N'importe quel membre, si l'auteur a quitté le voyage : sans cette règle
 *    une proposition orpheline resterait indéletable pour tout le monde.
 *
 * Roster inconnu => on s'en tient à 1 et 2 : on ne devine pas un droit de
 * suppression sur la proposition de quelqu'un d'autre.
 */
function mayDelete(activity, actingUserId, trip, memberIds) {
    if (trip && trip.user_id != null && String(trip.user_id) === String(actingUserId)) return true;
    if (String(activity.created_by) === String(actingUserId)) return true;
    if (!memberIds) return false;
    return !memberIds.has(String(activity.created_by));
}

function participationPct(voteCount, totalMembers) {
    if (!totalMembers) return 0;
    return Math.min(100, Math.round((voteCount / totalMembers) * 100));
}

function consensusPct(scores) {
    if (!scores.length) return 0;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const maxDiff = Math.max(...scores.map(s => Math.abs(s - avg)));
    return Math.round(Math.max(0, 100 - (maxDiff / 4 * 100)));
}

function parseScores(concatenated) {
    if (!concatenated) return [];
    return String(concatenated).split(',').map(Number).filter(Number.isFinite);
}

/**
 * Recherche Nominatim. Partagée par la route /geocode et create-trek-activity :
 * ctx.call() n'existe pas, une route ne peut pas appeler une autre route.
 * Ne rejette jamais — le géocodage est optionnel et ne doit rien bloquer.
 */
async function geocode(ctx, address) {
    const q = String(address == null ? '' : address).trim();
    if (!q) return {success: false, error: 'Address is required'};

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
    try {
        const url = 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q) + '&format=json&limit=1';
        const response = await fetch(url, {
            headers: {'User-Agent': 'Trek-Vox-Plugin/1.0'},
            signal: controller.signal
        });

        if (!response.ok) {
            ctx.log.warn('Geocoding API error', {status: response.status});
            return {success: false, error: 'API error: ' + response.status};
        }

        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) {
            const result = data[0];
            return {
                success: true,
                lat: parseFloat(result.lat),
                lng: parseFloat(result.lon),
                displayName: result.display_name,
                address: result.display_name || q
            };
        }

        return {success: false, error: 'No results found', address: q};
    } catch (e) {
        ctx.log.warn('Geocoding failed', {error: e && e.message, address: q});
        return {success: false, error: (e && e.message) || 'Geocoding failed'};
    } finally {
        clearTimeout(timer);
    }
}

const routes = [
    // ===== GET /api/plugins/vox/api/places =====
    {
        method: 'GET',
        path: '/places',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const tripId = (await assertTripAccess(ctx, req.query && req.query.tripId)).id;

            ctx.log.info('Fetching places from plugin database', {tripId});

            const places = await ctx.db.query(
                `SELECT p.*,
                        (SELECT COUNT(*) FROM activities a WHERE a.place_id = p.id) as activity_count
                 FROM places p
                 WHERE p.trip_id = ?
                 ORDER BY p.name ASC`,
                [tripId]
            );

            return json(200, places);
        })
    },

    // ===== GET /api/plugins/vox/api/trip-members =====
    {
        method: 'GET',
        path: '/trip-members',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const tripId = (await assertTripAccess(ctx, req.query && req.query.tripId)).id;

            ctx.log.info('Fetching trip members', {tripId});

            let members = [];
            try {
                const roster = await ctx.trips.members(tripId);
                members = Array.isArray(roster) ? roster : [];
            } catch (e) {
                ctx.log.warn('Could not fetch trip members', {error: e && e.message});
            }

            return json(200, {
                tripId: tripId,
                memberCount: members.length,
                members: members
            });
        })
    },

    // ===== POST /api/plugins/vox/api/places =====
    {
        method: 'POST',
        path: '/places',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const body = await readBody(req);
            const {name} = body;

            if (!name || !String(name).trim()) {
                return json(400, {error: 'Place name is required'});
            }

            const tripId = (await assertTripAccess(ctx, body.trip_id)).id;

            ctx.log.info('Creating place', {name, tripId, userId: req.user.id});

            try {
                const result = await ctx.db.query(
                    `INSERT INTO places (name, created_by, trip_id, created_at)
                    VALUES (?, ?, ?, unixepoch())
                    RETURNING *`,
                    [String(name).trim(), String(req.user.id), tripId]
                );

                return json(201, result[0]);
            } catch (e) {
                if (e.message && e.message.includes('UNIQUE constraint failed')) {
                    return json(409, {error: 'A place with this name already exists in this trip'});
                }
                throw e;
            }
        })
    },

    // ===== POST /api/plugins/vox/api/create-trek-activity =====
    {
        method: 'POST',
        path: '/create-trek-activity',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const body = await readBody(req);
            const {voxActivityId, activityName, notes, address, website, lat, lng} = body;

            // Charge l'activité ET vérifie l'accès à son voyage
            const {activity} = await loadActivityForUser(ctx, voxActivityId);
            const tripId = activity.trip_id;

            let placeName = '';
            if (activity.place_id) {
                const placeRow = await ctx.db.query('SELECT name FROM places WHERE id = ?', [activity.place_id]);
                placeName = placeRow.length ? placeRow[0].name : '';
            }

            // 1. Déterminer les données
            const finalAddress = address || placeName || '';
            const finalWebsite = website || activity.url || '';
            let finalLat = toNum(lat, null);
            let finalLng = toNum(lng, null);

            // 2. Tentative de géocodage SILENCIEUX (ça ne bloque pas)
            let geocoded = false;
            if (finalAddress && finalLat == null && finalLng == null) {
                const result = await geocode(ctx, finalAddress);
                if (result.success) {
                    finalLat = result.lat;
                    finalLng = result.lng;
                    geocoded = true;
                    ctx.log.info('Geocoding successful', {lat: finalLat, lng: finalLng});
                } else {
                    ctx.log.warn('Geocoding failed but continuing', {address: finalAddress, error: result.error});
                }
            }

            // 3. Construire les données pour TREK (toujours, même sans coordonnées)
            const trekPlaceData = {
                name: activityName || activity.title,
                address: finalAddress,
                lat: finalLat,
                lng: finalLng,
                website: finalWebsite,
                category_id: 6,
                place_time: '',
                end_time: '',
                notes: notes || `Created from Vox: ${activity.title}`,
                transport_mode: 'walking'
            };

            ctx.log.info('Creating TREK place', {
                name: trekPlaceData.name,
                hasCoords: !!(trekPlaceData.lat && trekPlaceData.lng)
            });

            // 4. Créer le lieu dans TREK
            let placeId = null;

            try {
                const newPlace = await ctx.places.create(tripId, trekPlaceData);
                placeId = newPlace && newPlace.id;
                ctx.log.info('New place created in TREK', {placeId});
            } catch (createError) {
                ctx.log.warn('Error creating place', {
                    message: createError.message,
                    code: createError.code
                });

                if (createError.message && createError.message.includes('UNIQUE constraint failed')) {
                    ctx.log.info('Place already exists, updating...');
                    try {
                        // La lecture des places d'un voyage passe par ctx.trips.getPlaces —
                        // ctx.places n'expose que create/update/delete.
                        const existingPlaces = await ctx.trips.getPlaces(tripId);
                        const existing = (existingPlaces || []).find(p =>
                            String(p.name).toLowerCase() === String(trekPlaceData.name).toLowerCase()
                        );
                        if (existing) {
                            const updated = await ctx.places.update(tripId, existing.id, trekPlaceData);
                            placeId = updated && updated.id;
                            ctx.log.info('Existing place updated', {placeId});
                        }
                    } catch (findError) {
                        ctx.log.error('Error finding existing place', {error: findError.message});
                    }
                } else {
                    throw createError;
                }
            }

            // 5. Mettre à jour l'activité Vox
            if (placeId) {
                await ctx.db.exec(
                    'UPDATE activities SET trek_place_id = ? WHERE id = ?',
                    [placeId, activity.id]
                );
            }

            return json(200, {
                success: !!placeId,
                voxActivityId: activity.id,
                trekPlaceId: placeId,
                tripId: tripId,
                message: placeId ? '✅ TREK activity created successfully' : '⚠️ Place not created',
                activityTitle: activity.title,
                placeData: {
                    name: trekPlaceData.name,
                    address: trekPlaceData.address,
                    website: trekPlaceData.website,
                    lat: trekPlaceData.lat,
                    lng: trekPlaceData.lng,
                    geocoded: geocoded
                }
            });
        })
    },

    // ===== GET /api/plugins/vox/api/geocode =====
    {
        method: 'GET',
        path: '/geocode',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const address = req.query && req.query.address ? String(req.query.address) : '';

            if (!address.trim()) {
                return json(400, {error: 'Address is required'});
            }

            ctx.log.info('Geocoding address via server proxy', {address});

            return json(200, await geocode(ctx, address));
        })
    },

    // ===== POST /api/plugins/vox/api/clean-orphaned-places =====
    {
        method: 'POST',
        path: '/clean-orphaned-places',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const body = await readBody(req);
            const tripId = (await assertTripAccess(ctx, body.tripId)).id;

            const results = {cleaned: 0, kept: 0, errors: [], details: []};

            const activitiesWithTrek = await ctx.db.query(
                'SELECT id, title, trek_place_id FROM activities WHERE trip_id = ? AND trek_place_id IS NOT NULL',
                [tripId]
            );

            if (!activitiesWithTrek.length) return json(200, results);

            // Une seule lecture du pool de lieux du voyage. L'ancienne version
            // sondait chaque lieu avec un places.update(..., {}) — une ÉCRITURE
            // TREK par activité, à chaque chargement d'onglet, tracée dans
            // l'audit log des capacités.
            let trekPlaceIds;
            try {
                const trekPlaces = await ctx.trips.getPlaces(tripId);
                trekPlaceIds = new Set((trekPlaces || []).map(p => String(p.id)));
            } catch (e) {
                results.errors.push({fatal: e && e.message});
                return json(200, results);
            }

            for (const activity of activitiesWithTrek) {
                if (trekPlaceIds.has(String(activity.trek_place_id))) {
                    results.kept++;
                    results.details.push({
                        activityId: activity.id,
                        title: activity.title,
                        trekPlaceId: activity.trek_place_id,
                        action: 'kept'
                    });
                    continue;
                }

                await ctx.db.exec('UPDATE activities SET trek_place_id = NULL WHERE id = ?', [activity.id]);
                results.cleaned++;
                results.details.push({
                    activityId: activity.id,
                    title: activity.title,
                    trekPlaceId: activity.trek_place_id,
                    action: 'cleaned',
                    reason: 'place no longer exists in the trip'
                });
            }

            return json(200, results);
        })
    },

    // ===== GET /api/plugins/vox/api/activities =====
    {
        method: 'GET',
        path: '/activities',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const trip = await assertTripAccess(ctx, req.query && req.query.tripId);
            const tripId = trip.id;
            const placeId = req.query && req.query.placeId ? req.query.placeId : null;

            ctx.log.info('Fetching activities', {tripId});

            // Un seul appel roster pour toutes les lignes : le client ne rejoue
            // pas la règle de suppression, il lit le can_delete qu'on calcule ici.
            const memberIds = await getTripMemberIds(ctx, tripId);

            let sql = `SELECT a.*,
                        (SELECT COUNT(*) FROM votes v WHERE v.activity_id = a.id) as vote_count,
                        (SELECT AVG(score) FROM votes v WHERE v.activity_id = a.id) as avg_score
                    FROM activities a
                    WHERE a.trip_id = ?`;
            const params = [tripId];

            if (placeId === 'none') {
                sql += ` AND a.place_id IS NULL`;
            } else if (placeId) {
                sql += ` AND a.place_id = ?`;
                params.push(toNum(placeId, null));
            }

            sql += ` ORDER BY a.created_at DESC`;

            const activities = await ctx.db.query(sql, params);

            // Enrichir avec les infos utilisateur via l'API TREK
            const enriched = await Promise.all(activities.map(async (activity) => {
                let creatorName = activity.created_by;
                try {
                    if (activity.created_by && activity.created_by !== 'system') {
                        const user = await ctx.users.getById(parseInt(activity.created_by, 10));
                        if (user) {
                            creatorName = user.display_name || user.username || activity.created_by;
                        }
                    }
                } catch (e) {
                    ctx.log.warn('Could not fetch user info', {userId: activity.created_by});
                }
                return {
                    ...activity,
                    creator_name: creatorName,
                    creator_display_name: creatorName,
                    can_delete: mayDelete(activity, req.user.id, trip, memberIds)
                };
            }));

            return json(200, enriched);
        })
    },

    // ===== POST /api/plugins/vox/api/activities =====
    {
        method: 'POST',
        path: '/activities',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const body = await readBody(req);
            const {title, description, url} = body;

            if (!title) {
                return json(400, {error: 'Title is required'});
            }

            const tripId = (await assertTripAccess(ctx, body.trip_id)).id;
            const placeId = await resolvePlaceInTrip(ctx, body.place_id, tripId);

            ctx.log.info('Creating activity', {title, tripId, userId: req.user.id, placeId});

            const result = await ctx.db.query(
                `INSERT INTO activities (title, description, url, created_by, place_id, trip_id)
                VALUES (?, ?, ?, ?, ?, ?)
                RETURNING *`,
                [title, description || '', url || '', String(req.user.id), placeId, tripId]
            );

            return json(201, result[0]);
        })
    },

    // ===== GET /api/plugins/vox/api/votes?activityId=XXX =====
    {
        method: 'GET',
        path: '/votes',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const {activity} = await loadActivityForUser(ctx, getActivityIdFromQuery(req));

            const votes = await ctx.db.query(
                `SELECT v.*
                FROM votes v
                WHERE v.activity_id = ?
                ORDER BY v.score DESC`,
                [activity.id]
            );

            // Enrichir avec les infos utilisateur via l'API TREK
            const enriched = await Promise.all(votes.map(async (vote) => {
                let userInfo = {username: vote.user_id, display_name: vote.user_id};
                try {
                    const user = await ctx.users.getById(parseInt(vote.user_id, 10));
                    if (user) {
                        userInfo = {
                            username: user.username || vote.user_id,
                            display_name: user.display_name || user.username || vote.user_id,
                            avatar: user.avatar || null
                        };
                    }
                } catch (e) {
                    ctx.log.warn('Could not fetch user info', {userId: vote.user_id});
                }
                return {
                    ...vote,
                    ...userInfo
                };
            }));

            return json(200, enriched);
        })
    },

    // ===== POST /api/plugins/vox/api/vote =====
    {
        method: 'POST',
        path: '/vote',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const body = await readBody(req);
            const score = toNum(body.score, null);

            if (score == null || !Number.isInteger(score) || score < 1 || score > 5) {
                return json(400, {error: 'Invalid vote data: activityId and an integer score (1-5) required'});
            }

            const {activity} = await loadActivityForUser(ctx, body.activityId);

            ctx.log.info('Submitting vote', {activityId: activity.id, score, userId: req.user.id});

            const totalMembers = await getTripMemberCount(ctx, activity.trip_id);

            // Insérer ou mettre à jour le vote
            await ctx.db.exec(
                `INSERT INTO votes (activity_id, user_id, score, updated_at)
            VALUES (?, ?, ?, unixepoch())
            ON CONFLICT(activity_id, user_id) DO UPDATE SET
                score = excluded.score,
                updated_at = excluded.updated_at`,
                [activity.id, String(req.user.id), score]
            );

            // Récupérer les stats mises à jour
            const stats = await ctx.db.query(
                `SELECT
                COUNT(*) as vote_count,
                AVG(score) as avg_score,
                GROUP_CONCAT(score) as all_scores
            FROM votes
            WHERE activity_id = ?`,
                [activity.id]
            );

            const statsData = stats[0] || {};
            const voteCount = statsData.vote_count || 0;

            return json(200, {
                vote_count: voteCount,
                avg_score: statsData.avg_score || 0,
                consensus: consensusPct(parseScores(statsData.all_scores)),
                participation: participationPct(voteCount, totalMembers),
                user_score: score,
                total_members: totalMembers
            });
        })
    },

    // ===== GET /api/plugins/vox/api/trip-member-count =====
    {
        method: 'GET',
        path: '/trip-member-count',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const tripId = (await assertTripAccess(ctx, req.query && req.query.tripId)).id;

            ctx.log.info('Fetching trip member count', {tripId});

            return json(200, {
                tripId: tripId,
                memberCount: await getTripMemberCount(ctx, tripId)
            });
        })
    },

    // ===== GET /api/plugins/vox/api/stats =====
    {
        method: 'GET',
        path: '/stats',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const tripId = (await assertTripAccess(ctx, req.query && req.query.tripId)).id;
            const placeId = req.query && req.query.placeId ? req.query.placeId : null;

            ctx.log.info('Fetching stats', {tripId});

            const totalMembers = await getTripMemberCount(ctx, tripId);

            let sql = `SELECT a.id, a.title, a.description, a.place_id, a.trip_id,
                    COUNT(DISTINCT v.user_id) as vote_count,
                    AVG(v.score) as avg_score,
                    GROUP_CONCAT(v.score) as all_scores
                FROM activities a
                LEFT JOIN votes v ON a.id = v.activity_id
                WHERE a.trip_id = ?`;
            const params = [tripId];

            if (placeId === 'none') {
                sql += ` AND a.place_id IS NULL`;
            } else if (placeId) {
                sql += ` AND a.place_id = ?`;
                params.push(toNum(placeId, null));
            }

            sql += ` GROUP BY a.id
                ORDER BY avg_score DESC NULLS LAST`;

            const activities = await ctx.db.query(sql, params);

            const stats = activities.map(activity => {
                const voteCount = activity.vote_count || 0;
                return {
                    id: activity.id,
                    title: activity.title,
                    description: activity.description,
                    place_id: activity.place_id,
                    trip_id: activity.trip_id,
                    vote_count: voteCount,
                    avg_score: activity.avg_score || 0,
                    consensus: consensusPct(parseScores(activity.all_scores)),
                    participation: participationPct(voteCount, totalMembers),
                    total_members: totalMembers
                };
            });

            return json(200, stats);
        })
    },

    // ===== PUT /api/plugins/vox/api/activities =====
    {
        method: 'PUT',
        path: '/activities',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const body = await readBody(req);
            const {id, title, description, url} = body;

            if (!title) {
                return json(400, {error: 'Title is required'});
            }

            // Charge l'activité ET vérifie l'accès à son voyage
            const {activity: existing} = await loadActivityForUser(ctx, id);
            const tripId = existing.trip_id;

            // Une activité ne change jamais de voyage : un trip_id différent dans
            // le corps serait un moyen de déplacer des votes hors de leur trip.
            if (body.trip_id != null && toNum(body.trip_id, null) !== tripId) {
                throw httpError(400, 'An activity cannot be moved to another trip');
            }

            const newPlaceId = await resolvePlaceInTrip(ctx, body.place_id, tripId);

            ctx.log.info('Updating activity', {activityId: existing.id, userId: req.user.id});

            await ctx.db.exec(
                `UPDATE activities
                SET title = ?, description = ?, url = ?, place_id = ?
                WHERE id = ?`,
                [title, description || '', url || '', newPlaceId, existing.id]
            );

            // Si l'ancien lieu est différent du nouveau et n'est plus utilisé, le supprimer
            const oldPlaceId = existing.place_id;
            if (oldPlaceId && oldPlaceId !== newPlaceId) {
                const remainingActivities = await ctx.db.query(
                    'SELECT COUNT(*) as count FROM activities WHERE place_id = ?',
                    [oldPlaceId]
                );

                if (remainingActivities[0].count === 0) {
                    ctx.log.info('Deleting orphaned place after update', {placeId: oldPlaceId});
                    await ctx.db.exec('DELETE FROM places WHERE id = ?', [oldPlaceId]);
                }
            }

            const updated = await ctx.db.query('SELECT * FROM activities WHERE id = ?', [existing.id]);

            return json(200, updated[0]);
        })
    },

    // ===== POST /api/plugins/vox/api/sync-trip-members =====
    {
        method: 'POST',
        path: '/sync-trip-members',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const body = await readBody(req);
            const tripId = (await assertTripAccess(ctx, body.tripId)).id;

            ctx.log.info('Syncing trip members', {tripId});

            let members = [];
            try {
                const roster = await ctx.trips.members(tripId);
                members = Array.isArray(roster) ? roster : [];
            } catch (e) {
                ctx.log.warn('Could not sync trip members', {error: e && e.message});
                return json(200, {success: false, tripId: tripId, memberCount: 0, error: e && e.message});
            }

            ctx.log.info(`Found ${members.length} members in trip`);

            // 1. Désactiver tous les membres existants
            await ctx.db.exec('UPDATE trip_members SET is_active = 0 WHERE trip_id = ?', [tripId]);

            // 2. Insérer ou réactiver les membres actuels
            for (const member of members) {
                await ctx.db.exec(
                    `INSERT INTO trip_members (trip_id, user_id, is_active)
                    VALUES (?, ?, 1)
                    ON CONFLICT(trip_id, user_id) DO UPDATE SET
                        is_active = 1,
                        joined_at = unixepoch()`,
                    [tripId, String(member.id)]
                );
            }

            // 3. Compter les membres actifs
            const result = await ctx.db.query(
                'SELECT COUNT(*) as count FROM trip_members WHERE trip_id = ? AND is_active = 1',
                [tripId]
            );

            return json(200, {
                success: true,
                memberCount: result[0] ? result[0].count : 0,
                tripId: tripId
            });
        })
    },

    // ===== DELETE /api/plugins/vox/api/activities =====
    {
        method: 'DELETE',
        path: '/activities',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const {activity, trip} = await loadActivityForUser(ctx, req.query && req.query.id);

            // L'édition reste ouverte à tous les membres ; la suppression, non —
            // elle emporte aussi tous les votes déjà reçus. Voir mayDelete().
            const memberIds = await getTripMemberIds(ctx, activity.trip_id);
            if (!mayDelete(activity, req.user.id, trip, memberIds)) {
                throw httpError(403, 'Only the member who proposed this activity, or the trip owner, can delete it');
            }

            ctx.log.info('Deleting activity', {activityId: activity.id, userId: req.user.id});

            const placeId = activity.place_id;

            // Supprimer d'abord les votes associés
            await ctx.db.exec('DELETE FROM votes WHERE activity_id = ?', [activity.id]);
            await ctx.db.exec('DELETE FROM activities WHERE id = ?', [activity.id]);

            // Si l'activité avait un lieu, vérifier s'il reste des activités associées
            if (placeId) {
                const remainingActivities = await ctx.db.query(
                    'SELECT COUNT(*) as count FROM activities WHERE place_id = ?',
                    [placeId]
                );

                if (remainingActivities[0].count === 0) {
                    ctx.log.info('Deleting orphaned place', {placeId});
                    await ctx.db.exec('DELETE FROM places WHERE id = ?', [placeId]);
                }
            }

            return json(200, {success: true});
        })
    }
];

module.exports = definePlugin({
    async onLoad(ctx) {
        ctx.log.info('Vox plugin loading...');

        // Créer les tables
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
