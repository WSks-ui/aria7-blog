export default async function handler(req, res) {
	try {
		const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
		const bvid = parsedUrl.searchParams.get("bvid");
		const metaOnly = parsedUrl.searchParams.get("meta") === "1";
		const sessdata = process.env.BILIBILI_SESSDATA || parsedUrl.searchParams.get("sessdata") || "";

		if (!bvid) {
			res.statusCode = 400;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Missing bvid parameter" }));
			return;
		}

		const apiHeaders = {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
			Referer: "https://www.bilibili.com",
		};
		if (sessdata) apiHeaders.Cookie = "SESSDATA=" + sessdata;

		const viewRes = await fetch(
			`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
			{ headers: apiHeaders },
		);

		if (!viewRes.ok) {
			const text = await viewRes.text();
			res.statusCode = 502;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: `view API ${viewRes.status}: ${text.slice(0, 100)}` }));
			return;
		}

		const viewData = await viewRes.json();
		if (viewData.code !== 0) {
			res.statusCode = 502;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: viewData.message || "Video not found" }));
			return;
		}

		const v = viewData.data;
		const cid = v.cid;

		if (metaOnly) {
			var audioUrl = '/api/bilibili-audio?bvid=' + bvid;
			if (sessdata) audioUrl += '&sessdata=' + encodeURIComponent(sessdata);
			res.statusCode = 200;
			res.setHeader("Content-Type", "application/json");
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.end(
				JSON.stringify({
					title: v.title || "Unknown",
					artist: v.owner?.name || "",
					pic: (v.pic || "").replace(/^http:/, "https:"),
					audio_url: audioUrl,
				}),
			);
			return;
		}

		const playRes = await fetch(
			`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=0&fnval=16&fnver=0&fourk=1`,
			{ headers: apiHeaders },
		);

		if (!playRes.ok) {
			const text = await playRes.text();
			res.statusCode = 502;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: `playurl API ${playRes.status}: ${text.slice(0, 100)}` }));
			return;
		}

		const playData = await playRes.json();
		const audio = playData.data?.dash?.audio?.[0];
		if (!audio?.baseUrl) {
			res.statusCode = 502;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "No audio stream available" }));
			return;
		}

		const audioRes = await fetch(audio.baseUrl, { headers: apiHeaders });

		if (!audioRes.ok) {
			res.statusCode = 502;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: `audio CDN ${audioRes.status}` }));
			return;
		}

		res.statusCode = 200;
		res.setHeader("Content-Type", audioRes.headers.get("Content-Type") || "audio/mp4");
		res.setHeader("Cache-Control", "public, max-age=86400");
		res.setHeader("Access-Control-Allow-Origin", "*");

		if (audioRes.body && typeof audioRes.body.pipe === "function") {
			audioRes.body.pipe(res);
		} else if (audioRes.body && audioRes.body.getReader) {
			const reader = audioRes.body.getReader();
			const pump = async () => {
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						res.end();
						break;
					}
					res.write(value);
				}
			};
			pump().catch(() => {
				if (!res.writableEnded) res.end();
			});
		} else {
			const buffer = await audioRes.arrayBuffer();
			res.end(Buffer.from(buffer));
		}
	} catch (err) {
		if (!res.headersSent) {
			res.statusCode = 502;
			res.setHeader("Content-Type", "application/json");
		}
		res.end(JSON.stringify({ error: err.message || String(err) }));
	}
}
