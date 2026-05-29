const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "..", "api");
const destDir = path.join(__dirname, "..", "dist", "api");

if (!fs.existsSync(srcDir)) {
	console.log("No api/ directory found, skipping copy.");
	process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });

const files = fs.readdirSync(srcDir);
files.forEach((file) => {
	if (!file.endsWith(".js")) return;
	const src = path.join(srcDir, file);
	const dest = path.join(destDir, file);
	fs.copyFileSync(src, dest);
	console.log(`Copied api/${file} -> dist/api/${file}`);
});

console.log("API functions copied to dist/api/");
