export default async function handler(req, res) {
	try {
		const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
		const mediaId = parsedUrl.searchParams.get("media_id");
		const metaOnly = parsedUrl.searchParams.get("meta") === "1";

		if (!mediaId) {
			res.statusCode = 400;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Missing media_id parameter" }));
			return;
		}

		const apiHeaders = {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
			Referer: "https://www.bilibili.com",
		};

		// Step 1: Get collection info
		const infoRes = await fetch(
			`https://api.bilibili.com/x/v3/fav/resource/info?media_id=${mediaId}`,
			{ headers: apiHeaders },
		);
		if (!infoRes.ok) {
			res.statusCode = 502;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: `info API ${infoRes.status}` }));
			return;
		}
		const infoData = await infoRes.json();
		if (infoData.code !== 0) {
			res.statusCode = 502;
			res.setHeader("Content-Type", "application/json");
			res.end(
				JSON.stringify({ error: infoData.message || "Collection not found" }),
			);
			return;
		}
		const coll = infoData.data || {};
		const title = coll.title || "Unknown Collection";
		const cover = (coll.cover || "").replace(/^http:/, "https:");
		const count = coll.media_count || 0;

		// Step 2: Get video list (first page, up to 20)
		const listRes = await fetch(
			`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${mediaId}&pn=1&ps=20`,
			{ headers: apiHeaders },
		);
		if (!listRes.ok) {
			res.statusCode = 502;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: `list API ${listRes.status}` }));
			return;
		}
		const listData = await listRes.json();
		if (listData.code !== 0) {
			res.statusCode = 502;
			res.setHeader("Content-Type", "application/json");
			res.end(
				JSON.stringify({ error: listData.message || "List failed" }),
			);
			return;
		}
		const medias = listData.data?.medias || [];

		if (metaOnly) {
			// Return meta + track list for UI
			const tracks = medias.map((m) => ({
				bvid: m.bvid,
				title: m.title || "Unknown",
				artist: m.upper?.name || "",
				pic: (m.cover || "").replace(/^http:/, "https:"),
				audio_url: `/api/bilibili-audio?bvid=${m.bvid}`,
			}));
			res.statusCode = 200;
			res.setHeader("Content-Type", "application/json");
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.end(
				JSON.stringify({
					title: title,
					cover: cover,
					count: count,
					tracks: tracks.slice(0, 10),
				}),
			);
			return;
		}

		// Full mode: get all tracks' audio URLs (limit 10)
		var results = [];
		var candidates = medias.slice(0, 10);
		for (var i = 0; i < candidates.length; i++) {
			var m = candidates[i];
			try {
				results.push({
					name: m.title || "Unknown",
					artist: m.upper?.name || "",
					url: `/api/bilibili-audio?bvid=${m.bvid}`,
					pic: (m.cover || "").replace(/^http:/, "https:"),
					lrc: "",
				});
			} catch (e) {
				// skip failed tracks
			}
		}

		res.statusCode = 200;
		res.setHeader("Content-Type", "application/json");
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.end(JSON.stringify({ title: title, cover: cover, data: results }));
	} catch (err) {
		if (!res.headersSent) {
			res.statusCode = 502;
			res.setHeader("Content-Type", "application/json");
		}
		res.end(JSON.stringify({ error: err.message || String(err) }));
	}
}
