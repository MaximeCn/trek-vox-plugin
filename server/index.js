const {definePlugin} = require('trek-plugin-sdk');

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

async function getMemberCount(ctx, tripId) {
    try {
        const result = await ctx.db.query(
                `SELECT COUNT(DISTINCT v.user_id) as count
            FROM votes v
            JOIN activities a ON v.activity_id = a.id
            WHERE a.trip_id = ?`,
            [tripId]
        );
        const count = result[0]?.count || 0;
        return Math.max(1, count); // Au moins 1 (l'utilisateur qui vote)
    } catch (e) {
        ctx.log.warn('Could not count voters', {error: e.message});
        return 1;
    }
}

const routes = [
    // ===== GET /api/plugins/vox/api/places =====
    {
        method: 'GET',
        path: '/places',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            ctx.log.info('Fetching places from plugin database');

            const tripId = req.query && req.query.tripId ? toNum(req.query.tripId, null) : null;

            let sql = `SELECT p.*, 
                        (SELECT COUNT(*) FROM activities a WHERE a.place_id = p.id) as activity_count
                        FROM places p`;
            let params = [];

            if (tripId) {
                sql += ` WHERE p.trip_id = ?`;
                params = [tripId];
            }

            sql += ` ORDER BY p.name ASC`;

            const places = await ctx.db.query(sql, params);

            return json(200, places);
        })
    },

    // ===== GET /api/plugins/vox/api/trip-members =====
    {
        method: 'GET',
        path: '/trip-members',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const tripId = req.query && req.query.tripId ? toNum(req.query.tripId, null) : null;

            if (!tripId) {
                return json(400, {error: 'Trip ID is required'});
            }

            ctx.log.info('Fetching trip members', {tripId});

            try {
                const trip = await ctx.trips.getById(tripId);
                const members = trip.members || [];

                return json(200, {
                    tripId: tripId,
                    memberCount: members.length,
                    members: members
                });
            } catch (e) {
                ctx.log.warn('Could not fetch trip members', {error: e.message});
                return json(200, {tripId: tripId, memberCount: 0, members: []});
            }
        })
    },

    // ===== POST /api/plugins/vox/api/places =====
    {
        method: 'POST',
        path: '/places',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const body = await readBody(req);
            const {name, trip_id} = body;

            if (!name || !name.trim()) {
                return json(400, {error: 'Place name is required'});
            }

            if (!trip_id) {
                return json(400, {error: 'Trip ID is required'});
            }

            ctx.log.info('Creating place', {name, trip_id, userId: req.user.id});

            try {
                const result = await ctx.db.query(
                    `INSERT INTO places (name, created_by, trip_id, created_at)
                    VALUES (?, ?, ?, unixepoch())
                    RETURNING *`,
                    [name.trim(), String(req.user.id), trip_id]
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

            if (!voxActivityId) {
                return json(400, {error: 'voxActivityId is required'});
            }

            try {
                // 1. Récupérer l'activité Vox
                const voxActivity = await ctx.db.query(
                    `SELECT a.*, p.name as place_name
                 FROM activities a
                 LEFT JOIN places p ON a.place_id = p.id
                 WHERE a.id = ?`,
                    [voxActivityId]
                );

                if (!voxActivity.length) {
                    return json(404, {error: 'Vox activity not found'});
                }

                const activity = voxActivity[0];
                const tripId = activity.trip_id;

                // 2. Déterminer les données
                let finalAddress = address || activity.place_name || '';
                let finalWebsite = website || activity.url || '';
                let finalLat = lat ? parseFloat(lat) : null;
                let finalLng = lng ? parseFloat(lng) : null;

                // 3. Tentative de géocodage SILENCIEUX (ça ne bloque pas)
                let geocoded = false;
                if (finalAddress && !finalLat && !finalLng) {
                    try {
                        ctx.log.warn('Geocoding address (non-blocking)', {address: finalAddress});

                        // Appel interne au proxy
                        const geocodeResponse = await ctx.call('GET', '/geocode', {address: finalAddress});

                        if (geocodeResponse && geocodeResponse.success) {
                            finalLat = geocodeResponse.lat;
                            finalLng = geocodeResponse.lng;
                            geocoded = true;
                            ctx.log.info('Geocoding successful', {lat: finalLat, lng: finalLng});
                        } else {
                            ctx.log.warn('Geocoding failed but continuing', {address: finalAddress});
                        }
                    } catch (e) {
                        // NE PAS BLOQUER - juste logger
                        ctx.log.warn('Geocoding error (non-blocking)', {error: e.message});
                    }
                }

                // 4. Construire les données pour TREK (toujours, même sans coordonnées)
                const trekPlaceData = {
                    name: activityName || activity.title,
                    //description: `Activité: ${activity.title}` + (notes ? `\n${notes}` : ''),
                    address: finalAddress,
                    lat: finalLat,
                    lng: finalLng,
                    website: finalWebsite,
                    category_id: 6,
                    place_time: '',
                    end_time: '',
                    notes: notes || `Créé depuis Vox: ${activity.title}`,
                    transport_mode: 'walking'
                };

                ctx.log.info('Creating TREK place', {
                    name: trekPlaceData.name,
                    hasCoords: !!(trekPlaceData.lat && trekPlaceData.lng)
                });

                // 5. Créer le lieu dans TREK
                let placeId = null;

                try {
                    const newPlace = await ctx.places.create(tripId, trekPlaceData);
                    placeId = newPlace?.id;
                    ctx.log.info('New place created in TREK', {placeId});
                } catch (createError) {
                    ctx.log.warn('Error creating place', {
                        message: createError.message,
                        code: createError.code
                    });

                    if (createError.message && createError.message.includes('UNIQUE constraint failed')) {
                        ctx.log.info('Place already exists, updating...');
                        try {
                            const existingPlaces = await ctx.places.list(tripId);
                            const existing = existingPlaces.find(p =>
                                p.name.toLowerCase() === trekPlaceData.name.toLowerCase()
                            );
                            if (existing) {
                                const updated = await ctx.places.update(tripId, existing.id, trekPlaceData);
                                placeId = updated.id;
                                ctx.log.info('Existing place updated', {placeId});
                            }
                        } catch (findError) {
                            ctx.log.error('Error finding existing place', {error: findError.message});
                        }
                    } else {
                        throw createError;
                    }
                }

                // 6. Mettre à jour l'activité Vox
                if (placeId) {
                    await ctx.db.exec(
                        'UPDATE activities SET trek_place_id = ? WHERE id = ?',
                        [placeId, voxActivityId]
                    );
                }

                // 7. Résultat
                return json(200, {
                    success: !!placeId,
                    voxActivityId: voxActivityId,
                    trekPlaceId: placeId,
                    tripId: tripId,
                    message: placeId ? '✅ Activité TREK créée avec succès' : '⚠️ Lieu non créé',
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

            } catch (e) {
                ctx.log.error('Error in create-trek-activity', {
                    message: e.message,
                    code: e.code,
                    stack: e.stack
                });

                // Même en cas d'erreur, on essaie de créer sans coordonnées
                return json(500, {
                    error: 'Erreur lors de la création: ' + e.message,
                    code: e.code || 'UNKNOWN'
                });
            }
        })
    },

    // ===== GET /api/plugins/vox/api/geocode =====
    {
        method: 'GET',
        path: '/geocode',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const address = req.query && req.query.address ? decodeURIComponent(req.query.address) : '';

            if (!address || address.trim() === '') {
                return json(400, {error: 'Address is required'});
            }

            ctx.log.info('Geocoding address via server proxy', {address});

            try {
                const encodedAddress = encodeURIComponent(address);
                const url = `https://nominatim.openstreetmap.org/search?q=${encodedAddress}&format=json&limit=1`;

                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'Trek-Vox-Plugin/1.0'
                    },
                    timeout: 5000 // 5 secondes timeout
                });

                if (!response.ok) {
                    ctx.log.warn('Geocoding API error', {status: response.status});
                    return json(200, {success: false, error: `API error: ${response.status}`});
                }

                const data = await response.json();

                if (data && data.length > 0) {
                    const result = data[0];
                    return json(200, {
                        success: true,
                        lat: parseFloat(result.lat),
                        lng: parseFloat(result.lon),
                        displayName: result.display_name,
                        address: result.display_name || address
                    });
                }

                return json(200, {
                    success: false,
                    error: 'No results found',
                    address: address
                });

            } catch (e) {
                ctx.log.warn('Geocoding failed', {error: e.message, address});
                return json(200, {
                    success: false,
                    error: e.message || 'Geocoding failed'
                });
            }
        })
    },

    // ===== POST /api/plugins/vox/api/clean-orphaned-places =====
    {
        method: 'POST',
        path: '/clean-orphaned-places',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const body = await readBody(req);
            const {tripId} = body;

            if (!tripId) {
                return json(400, {error: 'tripId is required'});
            }

            const results = {
                cleaned: 0,
                kept: 0,
                errors: [],
                details: []
            };

            try {
                // Récupérer toutes les activités avec trek_place_id
                const activitiesWithTrek = await ctx.db.query(
                    'SELECT id, title, trek_place_id FROM activities WHERE trip_id = ? AND trek_place_id IS NOT NULL',
                    [tripId]
                );

                for (const activity of activitiesWithTrek) {
                    try {
                        // Tentative de mise à jour avec les mêmes valeurs
                        await ctx.places.update(tripId, activity.trek_place_id, {});

                        // Le lieu existe encore
                        results.kept++;
                        results.details.push({
                            activityId: activity.id,
                            title: activity.title,
                            trekPlaceId: activity.trek_place_id,
                            action: 'kept'
                        });

                    } catch (e) {
                        // ✅ Vérifier si l'erreur indique que le lieu n'existe pas
                        const isPlaceNotFound = e.message && (
                            e.message.includes('no place') ||
                            e.message.includes('not found') ||
                            e.message.includes('does not exist') ||
                            e.message.includes('404') ||
                            e.code === 'NOT_FOUND' ||
                            e.code === 'RESOURCE_FORBIDDEN'
                        );

                        if (isPlaceNotFound) {
                            // Le lieu n'existe plus, on nettoie
                            results.details.push({
                                activityId: activity.id,
                                title: activity.title,
                                trekPlaceId: activity.trek_place_id,
                                action: 'cleaned',
                                reason: e.message,
                                code: e.code
                            });

                            await ctx.db.exec(
                                'UPDATE activities SET trek_place_id = NULL WHERE id = ?',
                                [activity.id]
                            );
                            results.cleaned++;
                        } else {
                            // Erreur inattendue (permission, etc.)
                            results.errors.push({
                                activityId: activity.id,
                                trekPlaceId: activity.trek_place_id,
                                error: e.message,
                                code: e.code
                            });
                        }
                    }
                }

            } catch (e) {
                results.errors.push({fatal: e.message});
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
            ctx.log.info('Fetching all activities');

            const tripId = req.query && req.query.tripId ? toNum(req.query.tripId, null) : null;
            const placeId = req.query && req.query.placeId ? req.query.placeId : null;

            let sql = `SELECT a.*, 
                        (SELECT COUNT(*) FROM votes v WHERE v.activity_id = a.id) as vote_count,
                        (SELECT AVG(score) FROM votes v WHERE v.activity_id = a.id) as avg_score
                    FROM activities a
                    WHERE 1=1`;
            let params = [];

            if (tripId) {
                sql += ` AND a.trip_id = ?`;
                params.push(tripId);
            }

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
                        const user = await ctx.users.getById(parseInt(activity.created_by));
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
                    creator_display_name: creatorName
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
            const {title, description, url, place_id, trip_id} = body;

            if (!title) {
                return json(400, {error: 'Title is required'});
            }

            if (!trip_id) {
                return json(400, {error: 'Trip ID is required'});
            }

            ctx.log.info('Creating activity', {title, trip_id, userId: req.user.id, place_id});

            const result = await ctx.db.query(
                `INSERT INTO activities (title, description, url, created_by, place_id, trip_id)
                VALUES (?, ?, ?, ?, ?, ?)
                RETURNING *`,
                [title, description || '', url || '', String(req.user.id), place_id || null, trip_id]
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
            const activityId = getActivityIdFromQuery(req);

            if (!activityId) {
                return json(400, {error: 'activityId required'});
            }

            const votes = await ctx.db.query(
                `SELECT v.*
                FROM votes v
                WHERE v.activity_id = ?
                ORDER BY v.score DESC`,
                [activityId]
            );

            // Enrichir avec les infos utilisateur via l'API TREK
            const enriched = await Promise.all(votes.map(async (vote) => {
                let userInfo = {username: vote.user_id, display_name: vote.user_id};
                try {
                    const user = await ctx.users.getById(parseInt(vote.user_id));
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
            const {activityId, score} = body;

            if (!activityId || !score || score < 1 || score > 5) {
                return json(400, {error: 'Invalid vote data: activityId and score (1-5) required'});
            }

            ctx.log.info('Submitting vote', {activityId, score, userId: req.user.id});

            // Vérifier que l'activité existe
            const activity = await ctx.db.query(
                'SELECT id, trip_id FROM activities WHERE id = ?',
                [activityId]
            );

            if (!activity.length) {
                return json(404, {error: 'Activity not found'});
            }

            const tripId = activity[0].trip_id;

            // Récupérer le nombre de membres du trip
            let totalMembers = 10;
            if (tripId) {
                try {
                    const trip = await ctx.trips.getById(tripId);
                    totalMembers = trip.members ? trip.members.length : 10;
                } catch (e) {
                    ctx.log.warn('Could not fetch trip members for vote', {error: e.message});
                }
            }

            // Insérer ou mettre à jour le vote
            await ctx.db.exec(
                `INSERT INTO votes (activity_id, user_id, score, updated_at)
            VALUES (?, ?, ?, unixepoch())
            ON CONFLICT(activity_id, user_id) DO UPDATE SET
                score = excluded.score,
                updated_at = excluded.updated_at`,
                [activityId, String(req.user.id), score]
            );

            // Récupérer les stats mises à jour
            const stats = await ctx.db.query(
                `SELECT 
                COUNT(*) as vote_count,
                AVG(score) as avg_score,
                GROUP_CONCAT(score) as all_scores
            FROM votes 
            WHERE activity_id = ?`,
                [activityId]
            );

            const statsData = stats[0];
            const scores = statsData.all_scores ? statsData.all_scores.split(',').map(Number) : [];
            let consensus = 0;
            if (scores.length > 0) {
                const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
                const maxDiff = Math.max(...scores.map(s => Math.abs(s - avg)));
                consensus = Math.max(0, 100 - (maxDiff / 4 * 100));
            }

            // Calcul de la participation basé sur le nombre réel de membres
            const voteCount = statsData.vote_count || 0;
            const participation = totalMembers > 0
                ? Math.min(100, Math.round((voteCount / totalMembers) * 100))
                : 0;

            return json(200, {
                vote_count: voteCount,
                avg_score: statsData.avg_score || 0,
                consensus: Math.round(consensus),
                participation: participation,
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
            const tripId = req.query && req.query.tripId ? toNum(req.query.tripId, null) : null;

            if (!tripId) {
                return json(400, {error: 'Trip ID is required'});
            }

            ctx.log.info('Fetching trip member count', {tripId});

            try {
                const trip = await ctx.trips.getById(tripId);
                const memberCount = trip.members ? trip.members.length : 0;

                return json(200, {
                    tripId: tripId,
                    memberCount: memberCount
                });
            } catch (e) {
                ctx.log.warn('Could not fetch trip members', {error: e.message});
                return json(200, {tripId: tripId, memberCount: 0});
            }
        })
    },

    // ===== GET /api/plugins/vox/api/stats =====
    {
        method: 'GET',
        path: '/stats',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            ctx.log.info('Fetching all stats');

            const tripId = req.query && req.query.tripId ? toNum(req.query.tripId, null) : null;
            const placeId = req.query && req.query.placeId ? req.query.placeId : null;

            // Récupérer le nombre de membres du trip
            const totalMembers = await getMemberCount(ctx, tripId);
            if (tripId) {
                try {
                    const trip = await ctx.trips.getById(tripId);
                    totalMembers = trip.members ? trip.members.length : 10;
                } catch (e) {
                    ctx.log.warn('Could not fetch trip members for stats', {error: e.message});
                }
            }

            let sql = `SELECT a.id, a.title, a.description, a.place_id, a.trip_id,
                    COUNT(DISTINCT v.user_id) as vote_count,
                    AVG(v.score) as avg_score,
                    GROUP_CONCAT(v.score) as all_scores
                FROM activities a
                LEFT JOIN votes v ON a.id = v.activity_id
                WHERE 1=1`;
            let params = [];

            if (tripId) {
                sql += ` AND a.trip_id = ?`;
                params.push(tripId);
            }

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
                const scores = activity.all_scores ? activity.all_scores.split(',').map(Number) : [];
                let consensus = 0;
                if (scores.length > 0) {
                    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
                    const maxDiff = Math.max(...scores.map(s => Math.abs(s - avg)));
                    consensus = Math.max(0, 100 - (maxDiff / 4 * 100));
                }

                // Calcul de la participation basé sur le nombre réel de membres
                const voteCount = activity.vote_count || 0;
                const participation = totalMembers > 0
                    ? Math.min(100, Math.round((voteCount / totalMembers) * 100))
                    : 0;

                return {
                    id: activity.id,
                    title: activity.title,
                    description: activity.description,
                    place_id: activity.place_id,
                    trip_id: activity.trip_id,
                    vote_count: voteCount,
                    avg_score: activity.avg_score || 0,
                    consensus: Math.round(consensus),
                    participation: participation,
                    total_members: totalMembers // Ajouté pour référence
                };
            });

            return json(200, stats);
        })
    },

    // ===== GET /api/plugins/vox/api/debug-all =====
    {
        method: 'GET',
        path: '/debug',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const tripId = req.query && req.query.tripId ? toNum(req.query.tripId, null) : null;

            const results = {
                tripId: tripId,
                timestamp: new Date().toISOString(),
                methods: {},
                errors: {}
            };

            // ---- 1. ctx.trips ----
            results.methods.trips = {};
            try {
                // getById
                if (tripId && typeof ctx.trips.getById === 'function') {
                    try {
                        const trip = await ctx.trips.getById(tripId);
                        results.methods.trips.getById = {
                            success: true,
                            keys: Object.keys(trip || {}),
                            trip: trip,
                            members: trip?.members,
                            membersType: typeof trip?.members,
                            isArray: Array.isArray(trip?.members),
                            membersLength: trip?.members?.length
                        };
                    } catch (e) {
                        results.methods.trips.getById = {success: false, error: e.message};
                    }
                }

                // getPlaces
                if (tripId && typeof ctx.trips.getPlaces === 'function') {
                    try {
                        const places = await ctx.trips.getPlaces(tripId);
                        results.methods.trips.getPlaces = {
                            success: true,
                            count: places?.length || 0,
                            sample: places?.slice(0, 3) || []
                        };
                    } catch (e) {
                        results.methods.trips.getPlaces = {success: false, error: e.message};
                    }
                }

                // getReservations
                if (tripId && typeof ctx.trips.getReservations === 'function') {
                    try {
                        const reservations = await ctx.trips.getReservations(tripId);
                        results.methods.trips.getReservations = {
                            success: true,
                            count: reservations?.length || 0,
                            sample: reservations?.slice(0, 3) || []
                        };
                    } catch (e) {
                        results.methods.trips.getReservations = {success: false, error: e.message};
                    }
                }

                // update
                results.methods.trips.update = {
                    available: typeof ctx.trips.update === 'function'
                };

            } catch (e) {
                results.methods.trips.error = e.message;
            }

            // ---- 2. ctx.meta (important!) ----
            results.methods.meta = {};
            if (tripId) {
                try {
                    // list - voir toutes les clés meta disponibles
                    if (typeof ctx.meta.list === 'function') {
                        try {
                            const allMeta = await ctx.meta.list(tripId);
                            results.methods.meta.list = {
                                success: true,
                                keys: allMeta,
                                count: allMeta?.length || 0
                            };

                            // Pour chaque clé, récupérer la valeur
                            if (allMeta && allMeta.length > 0) {
                                results.methods.meta.values = {};
                                for (const key of allMeta) {
                                    try {
                                        const value = await ctx.meta.get(tripId, key);
                                        results.methods.meta.values[key] = value;
                                    } catch (e) {
                                        results.methods.meta.values[key] = {error: e.message};
                                    }
                                }
                            }
                        } catch (e) {
                            results.methods.meta.list = {success: false, error: e.message};
                        }
                    }

                    // get - essayer des clés possibles pour les membres
                    const possibleKeys = ['members', 'members_count', 'participants', 'memberIds', 'userIds', 'memberCount', 'participantCount', 'attendees', 'guests', 'people'];
                    results.methods.meta.possibleKeys = {};
                    for (const key of possibleKeys) {
                        try {
                            const value = await ctx.meta.get(tripId, key);
                            results.methods.meta.possibleKeys[key] = {
                                exists: value !== null && value !== undefined,
                                type: typeof value,
                                value: value,
                                isArray: Array.isArray(value),
                                length: Array.isArray(value) ? value.length : undefined
                            };
                        } catch (e) {
                            results.methods.meta.possibleKeys[key] = {error: e.message};
                        }
                    }

                    // set - vérifier si on peut écrire
                    results.methods.meta.set = {
                        available: typeof ctx.meta.set === 'function'
                    };

                    // delete - vérifier si on peut supprimer
                    results.methods.meta.delete = {
                        available: typeof ctx.meta.delete === 'function'
                    };

                } catch (e) {
                    results.methods.meta.error = e.message;
                }
            } else {
                results.methods.meta = {error: 'No tripId provided'};
            }

            // ---- 3. ctx.users ----
            results.methods.users = {};
            try {
                // getById
                if (req.user && req.user.id && typeof ctx.users.getById === 'function') {
                    try {
                        const user = await ctx.users.getById(parseInt(req.user.id));
                        results.methods.users.getById = {
                            success: true,
                            user: user,
                            keys: Object.keys(user || {})
                        };
                    } catch (e) {
                        results.methods.users.getById = {success: false, error: e.message};
                    }
                }
            } catch (e) {
                results.methods.users.error = e.message;
            }

            // ---- 4. ctx.db ----
            results.methods.db = {};
            try {
                // query - voir les tables et leurs données
                if (typeof ctx.db.query === 'function') {
                    try {
                        const tables = await ctx.db.query("SELECT name FROM sqlite_master WHERE type='table'");
                        results.methods.db.tables = tables.map(t => t.name);

                        // Pour chaque table, compter les lignes
                        results.methods.db.rowCounts = {};
                        for (const table of tables.map(t => t.name)) {
                            try {
                                const count = await ctx.db.query(`SELECT COUNT(*) as count FROM ${table}`);
                                results.methods.db.rowCounts[table] = count[0]?.count || 0;
                            } catch (e) {
                                results.methods.db.rowCounts[table] = {error: e.message};
                            }
                        }

                        // Si tripId, compter les votants uniques
                        if (tripId) {
                            const voters = await ctx.db.query(
                                `SELECT COUNT(DISTINCT v.user_id) as count
                            FROM votes v
                            JOIN activities a ON v.activity_id = a.id
                            WHERE a.trip_id = ?`,
                                [tripId]
                            );
                            results.methods.db.uniqueVoters = voters[0]?.count || 0;

                            // Compter les activités par trip
                            const activities = await ctx.db.query(
                                'SELECT COUNT(*) as count FROM activities WHERE trip_id = ?',
                                [tripId]
                            );
                            results.methods.db.activityCount = activities[0]?.count || 0;

                            // Compter les votes par trip
                            const votes = await ctx.db.query(
                                'SELECT COUNT(*) as count FROM votes v JOIN activities a ON v.activity_id = a.id WHERE a.trip_id = ?',
                                [tripId]
                            );
                            results.methods.db.votesCount = votes[0]?.count || 0;

                            // Compter les places par trip
                            const places = await ctx.db.query(
                                'SELECT COUNT(*) as count FROM places WHERE trip_id = ?',
                                [tripId]
                            );
                            results.methods.db.placesCount = places[0]?.count || 0;
                        }

                        // Récupérer tous les users uniques qui ont voté (global)
                        const allVoters = await ctx.db.query(
                            'SELECT DISTINCT user_id FROM votes'
                        );
                        results.methods.db.allVoters = allVoters.map(v => v.user_id);

                    } catch (e) {
                        results.methods.db.query = {success: false, error: e.message};
                    }
                }
            } catch (e) {
                results.methods.db.error = e.message;
            }

            // ---- 5. ctx.costs ----
            results.methods.costs = {};
            if (tripId) {
                try {
                    if (typeof ctx.costs.getByTrip === 'function') {
                        try {
                            const costs = await ctx.costs.getByTrip(tripId);
                            results.methods.costs.getByTrip = {
                                success: true,
                                count: costs?.length || 0,
                                sample: costs?.slice(0, 3) || []
                            };
                            // Si des coûts existent, extraire les contributeurs uniques
                            if (costs && costs.length > 0) {
                                const contributors = new Set();
                                costs.forEach(c => {
                                    if (c.user_id) contributors.add(c.user_id);
                                    if (c.payer_id) contributors.add(c.payer_id);
                                });
                                results.methods.costs.uniqueContributors = Array.from(contributors);
                                results.methods.costs.contributorCount = contributors.size;
                            }
                        } catch (e) {
                            results.methods.costs.getByTrip = {success: false, error: e.message};
                        }
                    }
                } catch (e) {
                    results.methods.costs.error = e.message;
                }
            }

            // ---- 6. ctx.packing ----
            results.methods.packing = {};
            if (tripId) {
                try {
                    if (typeof ctx.packing.list === 'function') {
                        try {
                            const items = await ctx.packing.list(tripId);
                            results.methods.packing.list = {
                                success: true,
                                count: items?.length || 0,
                                sample: items?.slice(0, 3) || []
                            };
                        } catch (e) {
                            results.methods.packing.list = {success: false, error: e.message};
                        }
                    }
                } catch (e) {
                    results.methods.packing.error = e.message;
                }
            }

            // ---- 7. ctx.files ----
            results.methods.files = {};
            if (tripId) {
                try {
                    if (typeof ctx.files.list === 'function') {
                        try {
                            const files = await ctx.files.list(tripId);
                            results.methods.files.list = {
                                success: true,
                                count: files?.length || 0,
                                sample: files?.slice(0, 3) || []
                            };
                        } catch (e) {
                            results.methods.files.list = {success: false, error: e.message};
                        }
                    }
                } catch (e) {
                    results.methods.files.error = e.message;
                }
            }

            // ---- 8. ctx.ws ----
            results.methods.ws = {
                broadcastToTrip: typeof ctx.ws.broadcastToTrip === 'function',
                broadcastToUser: typeof ctx.ws.broadcastToUser === 'function'
            };

            // ---- 9. ctx.plugins ----
            results.methods.plugins = {
                call: typeof ctx.plugins.call === 'function'
            };

            // ---- 10. ctx.events ----
            results.methods.events = {
                emit: typeof ctx.events.emit === 'function'
            };

            // ---- 11. ctx.config ----
            results.methods.config = {
                available: !!ctx.config,
                keys: Object.keys(ctx.config || {})
            };

            // ---- 12. ctx.log ----
            results.methods.log = {
                info: typeof ctx.log.info === 'function',
                warn: typeof ctx.log.warn === 'function',
                error: typeof ctx.log.error === 'function'
            };

            // ---- 13. Informations générales ----
            results.context = {
                id: ctx.id,
                tripId: ctx.tripId || null,
                user: req.user || null
            };

            // ---- 14. Toutes les méthodes disponibles ----
            results.availableMethods = [];
            for (const key in ctx) {
                if (typeof ctx[key] === 'object' && ctx[key] !== null) {
                    const methods = Object.keys(ctx[key]).filter(k => typeof ctx[key][k] === 'function');
                    if (methods.length > 0) {
                        results.availableMethods.push({
                            namespace: key,
                            methods: methods
                        });
                    }
                }
            }

            // ---- 15. Synthèse des membres ----
            results.membersSummary = {
                fromMeta: results.methods.meta?.possibleKeys || {},
                fromDbUniqueVoters: results.methods.db?.uniqueVoters || 0,
                fromCostsContributors: results.methods.costs?.contributorCount || 0,
                fromPlacesCount: results.methods.db?.placesCount || 0,
                fromActivityCount: results.methods.db?.activityCount || 0
            };

            // ---- 16. Suggestions ----
            results.suggestions = [];
            if (results.methods.meta?.possibleKeys?.members?.exists) {
                results.suggestions.push('✅ Les membres sont dans ctx.meta avec la clé "members"');
            }
            if (results.methods.meta?.possibleKeys?.participants?.exists) {
                results.suggestions.push('✅ Les membres sont dans ctx.meta avec la clé "participants"');
            }
            if (results.methods.meta?.possibleKeys?.memberIds?.exists) {
                results.suggestions.push('✅ Les membres sont dans ctx.meta avec la clé "memberIds"');
            }
            if (results.methods.meta?.possibleKeys?.memberCount?.exists) {
                results.suggestions.push('✅ Le nombre de membres est dans ctx.meta avec la clé "memberCount"');
            }
            if (results.methods.meta?.possibleKeys?.members_count?.exists) {
                results.suggestions.push('✅ Le nombre de membres est dans ctx.meta avec la clé "members_count"');
            }
            if (results.methods.db?.uniqueVoters > 0) {
                results.suggestions.push(`📊 ${results.methods.db.uniqueVoters} votants uniques dans la base de données`);
            }
            if (results.methods.costs?.contributorCount > 0) {
                results.suggestions.push(`💰 ${results.methods.costs.contributorCount} contributeurs dans le budget`);
            }

            return json(200, results);
        })
    },

    // ===== PUT /api/plugins/vox/api/activities =====
    {
        method: 'PUT',
        path: '/activities',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const body = await readBody(req);
            const {id, title, description, url, place_id, trip_id} = body;

            if (!id) {
                return json(400, {error: 'Activity ID is required'});
            }

            if (!title) {
                return json(400, {error: 'Title is required'});
            }

            ctx.log.info('Updating activity', {activityId: id, userId: req.user.id});

            // Vérifier que l'activité existe et récupérer l'ancien place_id
            const oldActivity = await ctx.db.query(
                'SELECT * FROM activities WHERE id = ?',
                [id]
            );

            if (!oldActivity.length) {
                return json(404, {error: 'Activity not found'});
            }

            const oldPlaceId = oldActivity[0].place_id;
            const oldTripId = oldActivity[0].trip_id;

            // Mettre à jour l'activité
            await ctx.db.exec(
                `UPDATE activities 
                SET title = ?, description = ?, url = ?, place_id = ?, trip_id = ?
                WHERE id = ?`,
                [title, description || '', url || '', place_id || null, trip_id || oldTripId, id]
            );

            // Si l'ancien lieu est différent du nouveau et que l'ancien lieu n'est plus utilisé
            if (oldPlaceId && oldPlaceId !== place_id) {
                const remainingActivities = await ctx.db.query(
                    'SELECT COUNT(*) as count FROM activities WHERE place_id = ?',
                    [oldPlaceId]
                );

                if (remainingActivities[0].count === 0) {
                    ctx.log.info('Deleting orphaned place after update', {placeId: oldPlaceId});
                    await ctx.db.exec('DELETE FROM places WHERE id = ?', [oldPlaceId]);
                }
            }

            // Récupérer l'activité mise à jour
            const updated = await ctx.db.query(
                'SELECT * FROM activities WHERE id = ?',
                [id]
            );

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
            const {tripId} = body;

            if (!tripId) {
                return json(400, {error: 'Trip ID is required'});
            }

            ctx.log.info('Syncing trip members', {tripId});

            try {
                // Récupérer les membres du trip via l'API TREK
                const trip = await ctx.trips.getById(tripId);
                const members = trip.members || [];

                ctx.log.info(`Found ${members.length} members in trip`);

                // Synchroniser la table trip_members
                // 1. Désactiver tous les membres existants
                await ctx.db.exec(
                    'UPDATE trip_members SET is_active = 0 WHERE trip_id = ?',
                    [tripId]
                );

                // 2. Insérer ou réactiver les membres actuels
                for (const member of members) {
                    // Si le membre existe déjà, le réactiver
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

                const count = result[0]?.count || 0;

                return json(200, {
                    success: true,
                    memberCount: count,
                    tripId: tripId
                });

            } catch (e) {
                ctx.log.warn('Could not sync trip members', {error: e.message});
                return json(200, {tripId: tripId, memberCount: 0, error: e.message});
            }
        })
    },

    // ===== GET /api/plugins/vox/api/trip-member-count =====
    {
        method: 'GET',
        path: '/trip-member-count',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const tripId = req.query && req.query.tripId ? toNum(req.query.tripId, null) : null;

            if (!tripId) {
                return json(400, {error: 'Trip ID is required'});
            }

            // Essayer d'abord de récupérer depuis trip_members
            try {
                const result = await ctx.db.query(
                    'SELECT COUNT(*) as count FROM trip_members WHERE trip_id = ? AND is_active = 1',
                    [tripId]
                );

                const count = result[0]?.count || 0;

                // Si aucun membre n'est enregistré, synchroniser
                if (count === 0) {
                    ctx.log.info('No members in trip_members, syncing...');
                    // Appeler le sync automatiquement
                    await ctx.call('POST', '/sync-trip-members', {tripId});

                    // Re-query
                    const newResult = await ctx.db.query(
                        'SELECT COUNT(*) as count FROM trip_members WHERE trip_id = ? AND is_active = 1',
                        [tripId]
                    );
                    return json(200, {tripId: tripId, memberCount: newResult[0]?.count || 0});
                }

                return json(200, {tripId: tripId, memberCount: count});

            } catch (e) {
                ctx.log.warn('Could not fetch from trip_members, falling back to trips API', {error: e.message});

                // Fallback: utiliser l'API trips
                try {
                    const trip = await ctx.trips.getById(tripId);
                    const count = trip.members ? trip.members.length : 0;
                    return json(200, {tripId: tripId, memberCount: count});
                } catch (e2) {
                    return json(200, {tripId: tripId, memberCount: 0});
                }
            }
        })
    },

    // ===== DELETE /api/plugins/vox/api/activities =====
    {
        method: 'DELETE',
        path: '/activities',
        auth: true,
        handler: wrapHandler(async (req, ctx) => {
            const activityId = req.query && req.query.id ? toNum(req.query.id, null) : null;

            if (!activityId) {
                return json(400, {error: 'activityId required'});
            }

            ctx.log.info('Deleting activity', {activityId, userId: req.user.id});

            // Récupérer l'activité pour connaître son place_id
            const activity = await ctx.db.query(
                'SELECT * FROM activities WHERE id = ?',
                [activityId]
            );

            if (!activity.length) {
                return json(404, {error: 'Activity not found'});
            }

            const placeId = activity[0].place_id;

            // Supprimer d'abord les votes associés
            await ctx.db.exec('DELETE FROM votes WHERE activity_id = ?', [activityId]);
            await ctx.db.exec('DELETE FROM activities WHERE id = ?', [activityId]);

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