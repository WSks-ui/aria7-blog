export default async function handler(req, res) {
	const url = new URL(req.url, `https://${req.headers.host}`);
	const bvid = url.searchParams.get("bvid");

	if (!bvid) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "Missing bvid parameter" }));
		return;
	}

	try {
		const headers = {
			"User-Agent": req.headers["user-agent"] || "Mozilla/5.0",
			Referer: "https://www.bilibili.com",
		};

		const viewRes = await fetch(
			`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
			{ headers },
		);
		if (!viewRes.ok) {
			res.writeHead(502);
			res.end("Bilibili view API unavailable");
			return;
		}
		const viewData = await viewRes.json();
		if (viewData.code !== 0) {
			res.writeHead(502, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({ error: viewData.message || "Video not found" }),
			);
			return;
		}
		const cid = viewData.data.cid;

		const playRes = await fetch(
			`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=0&fnval=16&fnver=0&fourk=1`,
			{ headers },
		);
		if (!playRes.ok) {
			res.writeHead(502);
			res.end("Bilibili playurl API unavailable");
			return;
		}
		const playData = await playRes.json();
		if (playData.code !== 0 || !playData.data?.dash?.audio?.[0]?.baseUrl) {
			res.writeHead(502, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: playData.message || "No audio stream available",
				}),
			);
			return;
		}
		const audioUrl = playData.data.dash.audio[0].baseUrl;

		const audioRes = await fetch(audioUrl, { headers });
		if (!audioRes.ok) {
			res.writeHead(502);
			res.end("Unable to fetch audio from CDN");
			return;
		}

		res.writeHead(200, {
			"Content-Type": audioRes.headers.get("Content-Type") || "audio/mp4",
			"Cache-Control": "public, max-age=86400",
			"Access-Control-Allow-Origin": "*",
		});

		const reader = audioRes.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			res.write(value);
		}
		res.end();
	} catch (err) {
		res.writeHead(502, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: err.message }));
	}
}
