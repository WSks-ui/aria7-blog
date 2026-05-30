export default async function handler(req, res) {
	try {
		const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
		const mediaId = parsedUrl.searchParams.get("media_id");
		const userMid = parseInt(parsedUrl.searchParams.get("mid")) || 0;
		const metaOnly = parsedUrl.searchParams.get("meta") === "1";

		if (!mediaId) {
			return respond(res, 400, { error: "Missing media_id parameter" });
		}

		const apiHeaders = {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			Referer: "https://www.bilibili.com",
		};

		function respond(r, status, data) {
			r.statusCode = status;
			r.setHeader("Content-Type", "application/json");
			r.setHeader("Access-Control-Allow-Origin", "*");
			r.end(JSON.stringify(data));
		}

		function cleanPic(url) {
			return (url || "").replace(/^http:/, "https:");
		}

		function toTrackList(arr) {
			return (arr || []).slice(0, 10).map(function (m) {
				return {
					bvid: m.bvid,
					title: m.title || "Unknown",
					artist: (m.upper && m.upper.name) || "",
					pic: cleanPic(m.cover || m.pic || ""),
					audio_url: "/api/bilibili-audio?bvid=" + m.bvid,
				};
			});
		}

		var title = "";
		var cover = "";
		var count = 0;
		var collectionMid = userMid;
		var medias = null;

		// ── Step 1: Metadata via fav/folder/info (public, no auth) ──
		try {
			var mi = await fetch(
				"https://api.bilibili.com/x/v3/fav/folder/info?media_id=" + mediaId,
				{ headers: apiHeaders },
			);
			if (mi.ok) {
				var midata = await mi.json();
				if (midata.code === 0 && midata.data) {
					title = midata.data.title || title;
					count = typeof midata.data.media_count === "number" ? midata.data.media_count : count;
					cover = cleanPic(midata.data.cover || cover);
					// API-discovered mid always overrides user-provided mid
					if (midata.data.mid) collectionMid = midata.data.mid;
					if (midata.data.upper && midata.data.upper.name && !title) {
						title = midata.data.upper.name + "'s Collection";
					}
				}
			}
		} catch (e) { /* ok */ }

		if (count === 0 && title) {
			return respond(res, 502, {
				error: 'Collection "' + title + '" is empty (0 videos).',
			});
		}

		// ── Step 2: Try fav/resource/list ──────────────────────────
		if (!medias) {
			try {
				var fl = await fetch(
					"https://api.bilibili.com/x/v3/fav/resource/list?media_id=" + mediaId +
					"&pn=1&ps=20&platform=web&web_location=1550101",
					{ headers: { ...apiHeaders, Origin: "https://www.bilibili.com" } },
				);
				if (fl.ok) {
					var fldata = await fl.json();
					if (fldata.code === 0 && fldata.data) {
						medias = fldata.data.medias;
						if (fldata.data.info) {
							title = fldata.data.info.title || title;
							cover = cleanPic(fldata.data.info.cover || cover);
							count = fldata.data.info.media_count || count;
						}
					}
				}
			} catch (e) { /* ok */ }
		}

		// ── Step 3: Try seasons API ───────────────────────────────
		if (!medias && collectionMid) {
			try {
				var sl = await fetch(
					"https://api.bilibili.com/x/polymer/space/seasons_archives_list?mid=" +
					collectionMid + "&season_id=" + mediaId + "&page_num=1&page_size=20",
					{ headers: apiHeaders },
				);
				if (sl.ok) {
					var sldata = await sl.json();
					if (sldata.code === 0 && sldata.data) {
						var smeta = sldata.data.meta || {};
						title = smeta.name || title;
						count = smeta.total || count;
						cover = cleanPic(smeta.cover || cover);
						medias = (sldata.data.archives || []).map(function (a) {
							return { bvid: a.bvid, title: a.title, upper: a.owner || {}, cover: a.pic || a.cover };
						});
					}
				}
			} catch (e) { /* ok */ }
		}

		// ── Step 4: Try series API ────────────────────────────────
		if (!medias && collectionMid) {
			try {
				var sr = await fetch(
					"https://api.bilibili.com/x/series/archives?mid=" +
					collectionMid + "&series_id=" + mediaId + "&pn=1&ps=20",
					{ headers: apiHeaders },
				);
				if (sr.ok) {
					var srdata = await sr.json();
					if (srdata.code === 0 && srdata.data) {
						var srmeta = srdata.data.meta || {};
						title = srmeta.name || title;
						count = srmeta.total || count;
						medias = (srdata.data.archives || []).map(function (a) {
							return { bvid: a.bvid, title: a.title, upper: a.owner || {}, cover: a.pic || a.cover };
						});
					}
				}
			} catch (e) { /* ok */ }
		}

		// ── Step 5: HTML page scrape (last resort) ─────────────────
		if (!medias && collectionMid) {
			try {
				var htmlRes = await fetch(
					"https://space.bilibili.com/" + collectionMid +
					"/favlist?fid=" + mediaId + "&ftype=create",
					{
						headers: {
							...apiHeaders,
							Accept: "text/html,application/xhtml+xml",
						},
					},
				);
				if (htmlRes.ok) {
					var html = await htmlRes.text();

					// Try __INITIAL_STATE__ extraction (greedy match to get full JSON)
					var stateMatch = html.match(
						/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*\});[\s]*\(function/,
					);
					if (!stateMatch) {
						stateMatch = html.match(
							/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*\});/,
						);
					}
					if (stateMatch) {
						try {
							var state = JSON.parse(stateMatch[1]);
							var listData = null;
							if (state.favListRes && state.favListRes.data && state.favListRes.data.medias) {
								listData = state.favListRes.data;
							} else if (state.listRes && state.listRes.data && state.listRes.data.medias) {
								listData = state.listRes.data;
							} else if (state.mediaList && state.mediaList.data && state.mediaList.data.medias) {
								listData = state.mediaList.data;
							}
							// Also try deeper paths
							if (!listData && state.favRes && state.favRes.data && state.favRes.data.medias) {
								listData = state.favRes.data;
							}
							if (!listData && state.data && state.data.medias) {
								listData = state.data;
							}
							if (listData) {
								title = (listData.info && listData.info.title) || title;
								count = (listData.info && listData.info.media_count) || count;
								cover = cleanPic((listData.info && listData.info.cover) || cover);
								medias = listData.medias;
							}
						} catch (parseErr) {
							// JSON parse failed, try regex fallback
						}
					}

					// Regex fallback: extract BVIDs from page
					if (!medias) {
						var bvidRegex = /BV[a-zA-Z0-9]{10}/g;
						var raw = html.match(bvidRegex) || [];
						var seen = {};
						var unique = [];
						for (var k = 0; k < raw.length; k++) {
							if (!seen[raw[k]]) {
								seen[raw[k]] = true;
								unique.push(raw[k]);
							}
						}
						if (unique.length > 0) {
							medias = unique.map(function (bvid) {
								return { bvid: bvid, title: bvid, upper: {}, cover: "" };
							});
						}
					}
				}
			} catch (e) { /* ok */ }
		}

		if (!medias || medias.length === 0) {
			var detailSuffix = collectionMid && collectionMid !== userMid
				? " (Note: this collection belongs to user " + collectionMid + ", not " + userMid + ")"
				: "";
			var msg = "Cannot fetch collection contents. "
				+ (collectionMid
					? "The collection may require authentication." + detailSuffix
					: "Please provide the Bilibili user ID (mid). "
					+ "e.g. space.bilibili.com/450438868 → mid=450438868"
				);
			return respond(res, 502, { error: msg });
		}

		if (!title) title = "Collection " + mediaId;

		if (metaOnly) {
			return respond(res, 200, {
				title: title,
				cover: cover,
				count: count,
				tracks: toTrackList(medias),
			});
		}

		var playlist = medias.slice(0, 10).map(function (m) {
			return {
				name: m.title || "Unknown",
				artist: (m.upper && m.upper.name) || "",
				url: "/api/bilibili-audio?bvid=" + m.bvid,
				pic: cleanPic(m.cover || m.pic || ""),
				lrc: "",
			};
		});
		return respond(res, 200, { title: title, cover: cover, data: playlist });
	} catch (err) {
		if (!res.headersSent) {
			res.statusCode = 502;
			res.setHeader("Content-Type", "application/json");
			res.setHeader("Access-Control-Allow-Origin", "*");
		}
		res.end(JSON.stringify({ error: err.message || String(err) }));
	}
}
