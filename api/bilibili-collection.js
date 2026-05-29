export default async function handler(req, res) {
	try {
		const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
		const mediaId = parsedUrl.searchParams.get("media_id");
		const metaOnly = parsedUrl.searchParams.get("meta") === "1";

		if (!mediaId) {
			return respond(res, 400, { error: "Missing media_id parameter" });
		}

		const apiHeaders = {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
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

		var title = "";
		var cover = "";
		var count = 0;
		var medias = [];

		// ── Try 1: Series/Collection API (works without auth) ──
		function tryFetchSeries(mid) {
			return fetch(
				`https://api.bilibili.com/x/series/archives?mid=${mid}&series_id=${mediaId}&pn=1&ps=20`,
				{ headers: apiHeaders },
			).then(function (r) {
				if (!r.ok) return null;
				return r.json();
			}).then(function (d) {
				if (!d || d.code !== 0 || !d.data) return null;
				var meta = d.data.meta || {};
				title = meta.name || title;
				count = meta.total || 0;
				return (d.data.archives || []).map(function (a) {
					return {
						bvid: a.bvid,
						title: a.title,
						upper: { name: (a.owner && a.owner.name) || "" },
						cover: cleanPic(a.pic || a.cover),
					};
				});
			});
		}

		// ── Try 2: Polymer space seasons API ───────────────────
		function tryFetchSeasons(mid) {
			return fetch(
				`https://api.bilibili.com/x/polymer/space/seasons_archives_list?mid=${mid}&season_id=${mediaId}&page_num=1&page_size=20`,
				{ headers: apiHeaders },
			).then(function (r) {
				if (!r.ok) return null;
				return r.json();
			}).then(function (d) {
				if (!d || d.code !== 0 || !d.data) return null;
				var meta = d.data.meta || {};
				title = meta.name || title;
				count = meta.total || 0;
				cover = cleanPic(meta.cover || cover);
				return (d.data.archives || []).map(function (a) {
					return {
						bvid: a.bvid,
						title: a.title,
						upper: { name: (a.owner && a.owner.name) || "" },
						cover: cleanPic(a.pic || a.cover),
					};
				});
			});
		}

		// ── Try 3: Fav folder info + list (may need auth) ──────
		async function tryFetchFav() {
			try {
				var iRes = await fetch(
					`https://api.bilibili.com/x/v3/fav/folder/info?media_id=${mediaId}`,
					{ headers: apiHeaders },
				);
				if (!iRes.ok) return null;
				var iData = await iRes.json();
				if (iData.code !== 0) return null;
				var info = iData.data || {};
				title = info.title || title;
				count = info.media_count || count;
				cover = cleanPic(info.cover || cover);

				var lRes = await fetch(
					`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${mediaId}&pn=1&ps=20&platform=web`,
					{ headers: { ...apiHeaders, Origin: "https://www.bilibili.com" } },
				);
				if (!lRes.ok) return null;
				var lData = await lRes.json();
				if (lData.code !== 0) return null;
				return (lData.data && lData.data.medias || []).map(function (m) {
					return {
						bvid: m.bvid,
						title: m.title,
						upper: { name: (m.upper && m.upper.name) || "" },
						cover: cleanPic(m.cover),
					};
				});
			} catch (e) {
				return null;
			}
		}

		// ── Try all sources in order ───────────────────────────
		var results;

		// Need user mid for series/seasons APIs — use fav folder info as source
		var foundMid = 0;
		try {
			var midInfo = await fetch(
				`https://api.bilibili.com/x/v3/fav/folder/info?media_id=${mediaId}`,
				{ headers: apiHeaders },
			);
			if (midInfo.ok) {
				var midData = await midInfo.json();
				if (midData.code === 0 && midData.data) {
					title = midData.data.title || title;
					count = midData.data.media_count || count;
					cover = cleanPic(midData.data.cover || cover);
					foundMid = midData.data.mid || 0;
				}
			}
		} catch (e) {
			/* silent */
		}

		if (foundMid) {
			results = await tryFetchSeasons(foundMid);
			if (!results || results.length === 0) {
				results = await tryFetchSeries(foundMid);
			}
		}

		if ((!results || results.length === 0) && foundMid) {
			results = await tryFetchFav();
		}

		medias = results || [];

		if (medias.length === 0) {
			return respond(res, 502, {
				error:
					"This collection may require authentication (private folder) or is empty. Try setting the playlist to public in Bilibili settings.",
			});
		}

		if (!title) title = "Collection " + mediaId;

		if (metaOnly) {
			var tracks = medias.slice(0, 10).map(function (m) {
				return {
					bvid: m.bvid,
					title: m.title || "Unknown",
					artist: (m.upper && m.upper.name) || "",
					pic: cleanPic(m.cover || ""),
					audio_url: "/api/bilibili-audio?bvid=" + m.bvid,
				};
			});
			return respond(res, 200, {
				title: title,
				cover: cover,
				count: count,
				tracks: tracks,
			});
		}

		// Full mode: playlist for player
		var playlist = medias.slice(0, 10).map(function (m) {
			return {
				name: m.title || "Unknown",
				artist: (m.upper && m.upper.name) || "",
				url: "/api/bilibili-audio?bvid=" + m.bvid,
				pic: cleanPic(m.cover || ""),
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
