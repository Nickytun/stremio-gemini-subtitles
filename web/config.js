const form = document.getElementById("configForm");
const source = document.getElementById("sourceLang");
const target = document.getElementById("targetLang");
const geminiApiKey = document.getElementById("geminiApiKey");
const geminiKeyField = document.getElementById("geminiKeyField");
const copyButton = document.getElementById("copyManifest");
const openStremioWebButton = document.getElementById("openStremioWeb");
const copyStatus = document.getElementById("copyStatus");

function manifestUrl() {
    const baseUrl = `${location.origin}/configure/${encodeURIComponent(source.value)}/${encodeURIComponent(target.value)}`;
    const provider = selectedProvider();

    if (provider !== "gemini") return `${baseUrl}/${provider}/manifest.json`;

    const key = geminiApiKey.value.trim();
    // Không nhập key ở đây thì server sẽ dùng GEMINI_KEYS trong biến môi trường.
    if (!key) return `${baseUrl}/gemini/manifest.json`;

    return `${baseUrl}/gemini/${encodeProviderKey(key)}/manifest.json`;
}

function stremioWebUrl() {
    return `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl())}`;
}

function updateView() {
    geminiKeyField.hidden = selectedProvider() !== "gemini";
    copyStatus.textContent = "";
}

form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!validateConfig()) return;

    location.href = manifestUrl().replace(/^https?:\/\//, "stremio://");
});

copyButton.addEventListener("click", async () => {
    if (!validateConfig()) return;

    try {
        await copyText(manifestUrl());
        copyStatus.textContent = "Đã copy";
    } catch {
        copyStatus.textContent = "Copy thất bại";
    }
});

openStremioWebButton.addEventListener("click", () => {
    if (!validateConfig()) return;

    location.href = stremioWebUrl();
});

source.addEventListener("change", updateView);
target.addEventListener("change", updateView);
geminiApiKey.addEventListener("input", updateView);
document.querySelectorAll("input[name='translationProvider']").forEach((input) => {
    input.addEventListener("change", updateView);
});
updateView();

function selectedProvider() {
    const checked = document.querySelector("input[name='translationProvider']:checked");
    return checked ? checked.value : "gemini";
}

function encodeProviderKey(value) {
    return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function validateConfig() {
    if (source.value === target.value) {
        copyStatus.textContent = "Chọn ngôn ngữ nguồn khác ngôn ngữ đích";
        return false;
    }

    return true;
}

async function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return;
    }

    throw new Error("Clipboard không khả dụng");
}
