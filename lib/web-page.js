const fs = require("fs");
const path = require("path");
const { LANGUAGES } = require("./languages");

const WEB_DIR = path.join(__dirname, "..", "web");
const template = fs.readFileSync(path.join(WEB_DIR, "index.html"), "utf8");

function renderConfigPage() {
    const defaultSource = process.env.DEFAULT_SOURCE_LANG || "en";
    const defaultTarget = process.env.DEFAULT_TARGET_LANG || "vi";

    return template
        .replace("{{sourceOptions}}", languageOptions(defaultSource))
        .replace("{{targetOptions}}", languageOptions(defaultTarget));
}

function readWebAsset(assetName) {
    const safeName = path.basename(assetName);
    return fs.readFileSync(path.join(WEB_DIR, safeName), "utf8");
}

function languageOptions(selected) {
    return LANGUAGES.map(({ code, label }) => {
        const isSelected = code === selected ? " selected" : "";
        return `<option value="${escapeHtml(code)}"${isSelected}>${escapeHtml(label)}</option>`;
    }).join("");
}

function escapeHtml(value) {
    return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

module.exports = {
    readWebAsset,
    renderConfigPage,
};
