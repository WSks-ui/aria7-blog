export default async function handler(req, res) {
	try {
		const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
		const mediaId = parsedUrl.searchParams.get("media_id");
		const metaOnly = parsedUrl.searchParams.get("meta") === "1";
		const sessdata = process.env.BILIBILI_SESSDATA || parsedUrl.searchParams.get("sessdata") || "";

		if (!mediaId) {
			return respond(res, 200, { error: "Missing media_id parameter" });
		}

		const apiHeaders = {
			"User-Agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			Referer: "https://www.bilibili.com",
		};
		if (sessdata) apiHeaders.Cookie = "SESSDATA=" + sessdata;

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
		var medias = null;
		var ownerMid = 0;

		// ── Step 1: fav/folder/info ──────────────────────────────
		try {
			var mi = await fetch(
				"https://api.bilibili.com/x/v3/fav/folder/info?media_id=" + mediaId,
				{ headers: apiHeaders },
			);
			if (mi.ok) {
				var midata = await mi.json();
				if (midata.code === 0 && midata.data) {
					title = midata.data.title || title;
					count = midata.data.media_count || count;
					cover = cleanPic(midata.data.cover || cover);
					ownerMid = midata.data.mid || 0;
				}
			}
		} catch (e) { /* ok */ }

		// ── Step 2: fav/resource/list ────────────────────────────
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

		// ── Step 3: HTML page scrape ─────────────────────────────
		if (!medias && ownerMid) {
			try {
				var htmlRes = await fetch(
					"https://space.bilibili.com/" + ownerMid +
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
							} else if (state.mediaList && state.mediaList.data && state.mediaList.data.medias) {
								listData = state.mediaList.data;
							}
							if (!listData && state.favRes && state.favRes.data && state.favRes.data.medias) {
								listData = state.favRes.data;
							}
							if (listData) {
								title = (listData.info && listData.info.title) || title;
								count = (listData.info && listData.info.media_count) || count;
								cover = cleanPic((listData.info && listData.info.cover) || cover);
								medias = listData.medias;
							}
						} catch (parseErr) { /* */ }
					}

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
			return respond(res, 200, {
				error: "Cannot fetch collection contents. Please ensure the collection is public or set BILIBILI_SESSDATA in Vercel environment variables.",
			});
		}

		if (!title) title = "Collection " + mediaId;

		if (metaOnly) {
			return respond(res, 200, {
				title: title,
				cover: cover,
				count: count,
				tracks: medias.slice(0, 20).map(function (m) {
					return {
						bvid: m.bvid,
						title: m.title || "Unknown",
						artist: (m.upper && m.upper.name) || "",
						pic: cleanPic(m.cover || m.pic || ""),
					};
				}),
			});
		}

		var playlist = medias.slice(0, 20).map(function (m) {
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
			res.statusCode = 200;
			res.setHeader("Content-Type", "application/json");
			res.setHeader("Access-Control-Allow-Origin", "*");
			res.end(JSON.stringify({ error: err.message || String(err) }));
		}
	}
}
