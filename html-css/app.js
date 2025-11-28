// ===== SANGU HTML/CSS Playground – Advanced Version =====

// ---- Defaults ----
const defaultFiles = [
  {
    path: "index.html",
    content: `<!DOCTYPE html>
<html lang="ka">
<head>
  <meta charset="UTF-8" />
  <title>My first HTML page</title>
</head>
<body>

  <header>
    <h1>Welcome to SANGU Playground</h1>
  </header>

  <main>
    <p>შეცვალე HTML/CSS, დააჭირე Run Project ▶</p>
  </main>

  <footer>
    <small>© 2025 SANGU IT Department</small>
  </footer>

</body>
</html>`
  },
  {
    path: "style.css",
    content: `body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: #020617;
  color: #e5e7eb;
}

header, footer {
  background: #020617;
  padding: 12px 16px;
}

main {
  padding: 16px;
}`
  }
];

// Multiple projects storage
const STORAGE_KEY = "sanguPlaygroundProjectsV2";

// Runtime state
let projects = null;    // { active: string, list: { name: File[] } }
let files = [];         // current project files
let models = [];
let editor;
let currentIndex = 0;

// DOM refs
let listEl, nameEl, typeEl, previewEl, statusEl;
let liveToggleEl, templateSelectEl, shareTextEl, consoleOutputEl, projectSelectEl;

// Live preview debounce
let liveEnabled = false;
let liveTimer = null;

// ---------- Helpers ----------

function cloneFiles(arr) {
  return JSON.parse(JSON.stringify(arr));
}

function getLanguage(path) {
  const p = path.toLowerCase();
  if (p.endsWith(".html")) return "html";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".js")) return "javascript";
  return "plaintext";
}

// Attach <link rel="stylesheet" href="style.css"> if missing
function attachStyleCss(doc) {
  if (!doc || typeof doc !== "string") return doc;
  if (/href\s*=\s*["']style\.css["']/i.test(doc)) return doc;

  const linkTag = `  <link rel="stylesheet" href="style.css">`;

  if (doc.includes("</head>")) {
    return doc.replace("</head>", linkTag + "\n</head>");
  }
  if (/<head[^>]*>/i.test(doc)) {
    return doc.replace(/<head[^>]*>/i, m => m + "\n" + linkTag + "\n");
  }
  return linkTag + "\n" + doc;
}

// Inject console hook into HTML so console.log → parent
function injectConsoleHook(doc) {
  const script = `
<script>
(function(){
  function send(type, msg) {
    try {
      parent.postMessage({ __sanguConsole: true, type: type, message: msg }, "*");
    } catch(e) {}
  }
  ["log","warn","error"].forEach(function(m){
    var old = console[m];
    console[m] = function(){
      var args = Array.prototype.slice.call(arguments).join(" ");
      send(m, args);
      if (old) { try { old.apply(console, arguments); } catch(e){} }
    };
  });
  window.onerror = function(msg, src, line, col){
    send("error", msg + " (" + (src||"") + ":" + line + ":" + col + ")");
  };
})();
</script>`;

  if (doc.includes("</body>")) {
    return doc.replace("</body>", script + "\n</body>");
  }
  return doc + script;
}

function prepareHtml(doc) {
  doc = attachStyleCss(doc);
  doc = injectConsoleHook(doc);
  return doc;
}

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

// ---------- Projects (multi) ----------

function loadProjects() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || !obj.list) return null;
    return obj;
  } catch {
    return null;
  }
}

function saveProjects() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // ignore
  }
}

function ensureProjects() {
  const loaded = loadProjects();
  if (loaded) {
    projects = loaded;
  } else {
    projects = {
      active: "Default",
      list: {
        Default: cloneFiles(defaultFiles)
      }
    };
    saveProjects();
  }
}

function loadActiveProjectFiles() {
  const arr = projects.list[projects.active];
  files = arr ? cloneFiles(arr) : cloneFiles(defaultFiles);
}

function persistCurrentFiles() {
  projects.list[projects.active] = cloneFiles(files);
  saveProjects();
}

function renderProjectSelect() {
  if (!projectSelectEl) return;
  projectSelectEl.innerHTML = "";
  Object.keys(projects.list).forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === projects.active) opt.selected = true;
    projectSelectEl.appendChild(opt);
  });
}

// ---------- Console ----------

function appendConsoleLine(type, text) {
  if (!consoleOutputEl) return;
  const p = document.createElement("div");
  p.className = "console-line " + type;
  p.textContent = text;
  consoleOutputEl.appendChild(p);
  consoleOutputEl.scrollTop = consoleOutputEl.scrollHeight;
}

window.clearConsole = function () {
  if (consoleOutputEl) consoleOutputEl.innerHTML = "";
};

// Receive messages from iframe
window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || !data.__sanguConsole) return;
  const type = data.type || "log";
  const msg = data.message || "";
  appendConsoleLine(type, msg);
});

// ---------- ZIP (store, no compression) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (~c) >>> 0;
}

function stringToUint8(str) {
  if (window.TextEncoder) return new TextEncoder().encode(str);
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xff;
  return arr;
}

function createZipBlob(fileList) {
  const chunks = [];
  let totalSize = 0;
  const centralRecords = [];

  for (const f of fileList) {
    const name = f.path.replace(/\\/g, "/");
    const nameBytes = stringToUint8(name);
    const dataBytes = stringToUint8(f.content || "");
    const crc = crc32(dataBytes);
    const compSize = dataBytes.length;
    const uncompSize = compSize;

    const localOffset = totalSize;
    const localLen = 30 + nameBytes.length;
    const local = new Uint8Array(localLen);
    const dv = new DataView(local.buffer);

    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, compSize, true);
    dv.setUint32(22, uncompSize, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);

    local.set(nameBytes, 30);

    chunks.push(local);
    chunks.push(dataBytes);
    totalSize += local.length + dataBytes.length;

    centralRecords.push({ nameBytes, crc, compSize, uncompSize, localOffset });
  }

  const centralOffset = totalSize;

  for (const rec of centralRecords) {
    const nameBytes = rec.nameBytes;
    const headerLen = 46 + nameBytes.length;
    const cd = new Uint8Array(headerLen);
    const dv = new DataView(cd.buffer);

    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint16(14, 0, true);
    dv.setUint32(16, rec.crc, true);
    dv.setUint32(20, rec.compSize, true);
    dv.setUint32(24, rec.uncompSize, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, rec.localOffset, true);

    cd.set(nameBytes, 46);

    chunks.push(cd);
    totalSize += cd.length;
  }

  const centralSize = totalSize - centralOffset;
  const end = new Uint8Array(22);
  const dvEnd = new DataView(end.buffer);
  dvEnd.setUint32(0, 0x06054b50, true);
  dvEnd.setUint16(4, 0, true);
  dvEnd.setUint16(6, 0, true);
  dvEnd.setUint16(8, centralRecords.length, true);
  dvEnd.setUint16(10, centralRecords.length, true);
  dvEnd.setUint32(12, centralSize, true);
  dvEnd.setUint32(16, centralOffset, true);
  dvEnd.setUint16(20, 0, true);

  chunks.push(end);
  totalSize += end.length;

  const out = new Uint8Array(totalSize);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }

  return new Blob([out], { type: "application/zip" });
}

// ---------- MAIN INIT ----------

window.initPlayground = function () {
  listEl = document.getElementById("file-list");
  nameEl = document.getElementById("current-file-name");
  typeEl = document.getElementById("file-type-label");
  previewEl = document.getElementById("preview");
  statusEl = document.getElementById("status-bar-text");
  liveToggleEl = document.getElementById("live-toggle");
  templateSelectEl = document.getElementById("template-select");
  shareTextEl = document.getElementById("share-text");
  consoleOutputEl = document.getElementById("console-output");
  projectSelectEl = document.getElementById("project-select");

  ensureProjects();
  loadActiveProjectFiles();

  editor = monaco.editor.create(document.getElementById("editor"), {
    theme: "vs-dark",
    automaticLayout: true,
    fontSize: 14,
    minimap: { enabled: false }
  });

  models = files.map(f => monaco.editor.createModel(f.content, getLanguage(f.path)));

  function saveCurrent() {
    if (!models[currentIndex]) return;
    files[currentIndex].content = models[currentIndex].getValue();
    persistCurrentFiles();
  }

  function renderList() {
    listEl.innerHTML = "";
    files.forEach((f, i) => {
      const li = document.createElement("li");
      li.className = "file-item" + (i === currentIndex ? " active" : "");
      li.innerHTML = `<span>${f.path}</span>`;
      li.onclick = () => openFile(i);
      listEl.appendChild(li);
    });
  }

  function openFile(i) {
    saveCurrent();
    currentIndex = i;
    editor.setModel(models[i]);
    nameEl.textContent = files[i].path;
    typeEl.textContent = getLanguage(files[i].path).toUpperCase();
    renderList();
    setStatus("Editing: " + files[i].path);
  }

  // initial
  renderProjectSelect();
  openFile(0);

  // Live preview toggle
  liveToggleEl.addEventListener("change", () => {
    liveEnabled = liveToggleEl.checked;
    if (liveEnabled) {
      // ერთჯერადად გაუშვას
      runFile();
    }
  });

  editor.onDidChangeModelContent(() => {
    if (!liveEnabled) return;
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      runFile();
    }, 700);
  });

  // Snippets
  monaco.languages.registerCompletionItemProvider("html", {
    provideCompletionItems: () => ({
      suggestions: [
        {
          label: "html:base",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>\${1:Document}</title>
</head>
<body>
  \${2}
</body>
</html>`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        }
      ]
    })
  });

  monaco.languages.registerCompletionItemProvider("css", {
    provideCompletionItems: () => ({
      suggestions: [
        {
          label: "css:center",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: `display: flex;
justify-content: center;
align-items: center;`
        }
      ]
    })
  });

  monaco.languages.registerCompletionItemProvider("javascript", {
    provideCompletionItems: () => ({
      suggestions: [
        {
          label: "js:log",
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: `console.log("Value:", \${1});`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        }
      ]
    })
  });

  // expose helpers in closure
  window.__saveCurrentFile = saveCurrent;
};

// ---------- Public API (buttons) ----------

// Run only current file
window.runFile = function () {
  if (!previewEl) return;
  if (!editor) return;

  window.__saveCurrentFile();
  const file = files[currentIndex];
  const lang = getLanguage(file.path);
  let doc = "";

  if (lang === "html") {
    doc = prepareHtml(file.content);
  } else if (lang === "css") {
    doc = prepareHtml(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${file.path}</title>
  <style>
${file.content}
  </style>
</head>
<body>
  <main>
    <h2>${file.path}</h2>
    <p>CSS ფაილის პრევიუ. შეცვალე სტილი და ნახე შედეგი.</p>
    <div style="width:120px;height:120px;background:#1e3a8a;margin-top:12px;"></div>
  </main>
</body>
</html>`);
  } else if (lang === "javascript") {
    doc = prepareHtml(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${file.path}</title>
</head>
<body>
  <main>
    <h2>${file.path}</h2>
    <p>Console გახსენი (F12 → Console) და გამოიყენე console.log().</p>
  </main>
  <script>
${file.content}
  </script>
</body>
</html>`);
  } else {
    doc = `<pre>${file.content || ""}</pre>`;
  }

  clearConsole();
  previewEl.srcdoc = doc;
  setStatus("Ran file: " + file.path);
};

// Run whole project (first HTML)
window.runProject = function () {
  if (!previewEl) return;
  window.__saveCurrentFile();

  const html =
    files.find(f => f.path.toLowerCase().endsWith(".html")) || files[0];

  let doc = prepareHtml(html.content || "");
  clearConsole();
  previewEl.srcdoc = doc;
  setStatus("Project running: " + html.path);
};

// Add file
window.addFile = function () {
  const name = prompt("New filename:", "script.js");
  if (!name) return;

  window.__saveCurrentFile();
  const f = { path: name.trim(), content: "" };
  files.push(f);
  models.push(monaco.editor.createModel(f.content, getLanguage(f.path)));
  currentIndex = files.length - 1;
  editor.setModel(models[currentIndex]);
  document.getElementById("current-file-name").textContent = f.path;
  document.getElementById("file-type-label").textContent =
    getLanguage(f.path).toUpperCase();

  const listEl = document.getElementById("file-list");
  listEl.innerHTML = "";
  files.forEach((file, idx) => {
    const li = document.createElement("li");
    li.className = "file-item" + (idx === currentIndex ? " active" : "");
    li.innerHTML = `<span>${file.path}</span>`;
    li.onclick = () => {
      window.__saveCurrentFile();
      currentIndex = idx;
      editor.setModel(models[idx]);
      document.getElementById("current-file-name").textContent = file.path;
      document.getElementById("file-type-label").textContent =
        getLanguage(file.path).toUpperCase();
      window.initPlayground && setStatus("Editing: " + file.path);
    };
    listEl.appendChild(li);
  });

  projects.list[projects.active] = cloneFiles(files);
  saveProjects();
};

// Delete file
window.deleteFile = function () {
  if (files.length === 1) return alert("Cannot delete last file");
  if (!confirm(`Delete "${files[currentIndex].path}"?`)) return;

  models[currentIndex].dispose();
  files.splice(currentIndex, 1);
  models.splice(currentIndex, 1);
  currentIndex = 0;

  projects.list[projects.active] = cloneFiles(files);
  saveProjects();

  // reload
  location.reload();
};

// Reset current project
window.resetProject = function () {
  if (!confirm("Reset current project to default template?")) return;
  projects.list[projects.active] = cloneFiles(defaultFiles);
  saveProjects();
  location.reload();
};

// ZIP download
window.downloadProject = function () {
  try {
    window.__saveCurrentFile();
    const blob = createZipBlob(files);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (projects.active || "project") + ".zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("ZIP downloaded.");
  } catch (e) {
    console.error(e);
    alert("ZIP გენერაციის შეცდომა (Console-ში დეტალები).");
  }
};

// Upload (disabled – unzip არ გვაქვს)
window.uploadProject = function (ev) {
  alert("ZIP Upload ამ ვერსიაში გამორთულია (offline unzip არ გვაქვს).");
  ev.target.value = "";
};

// Export single HTML (inline CSS)
window.exportSingleHtml = function () {
  window.__saveCurrentFile();
  const html =
    files.find(f => f.path.toLowerCase().endsWith(".html")) || files[0];
  const cssFile = files.find(f => f.path.toLowerCase() === "style.css");
  const css = cssFile ? cssFile.content : "";

  let doc = html.content || "";
  // ამოვიღოთ<link ... style.css>
  doc = doc.replace(
    /<link[^>]*href\s*=\s*["']style\.css["'][^>]*>/i,
    ""
  );

  const styleTag = `<style>\n${css}\n</style>\n`;

  if (doc.includes("</head>")) {
    doc = doc.replace("</head>", styleTag + "</head>");
  } else if (/<head[^>]*>/i.test(doc)) {
    doc = doc.replace(/<head[^>]*>/i, m => m + "\n" + styleTag);
  } else {
    doc = styleTag + doc;
  }

  const blob = new Blob([doc], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (projects.active || "project") + ".html";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// Templates
window.insertTemplate = function () {
  const select = document.getElementById("template-select");
  const val = select.value;
  if (!val) return;

  const lang = getLanguage(files[currentIndex].path);
  if (lang !== "html") {
    if (!confirm("შაბლონი HTML ფაილზე მუშაობს. გადააწერო მიმდინარე ფაილს HTML-ით?")) {
      return;
    }
  }

  let tpl = "";
  if (val === "basic") {
    tpl = `<!DOCTYPE html>
<html lang="ka">
<head>
  <meta charset="UTF-8">
  <title>Basic page</title>
</head>
<body>
  <header>
    <h1>My first page</h1>
  </header>
  <main>
    <p>Welcome!</p>
  </main>
  <footer>
    <small>© 2025</small>
  </footer>
</body>
</html>`;
  } else if (val === "flex") {
    tpl = `<!DOCTYPE html>
<html lang="ka">
<head>
  <meta charset="UTF-8">
  <title>Flexbox layout</title>
</head>
<body>
  <header>Header</header>
  <nav>Menu</nav>
  <main class="layout">
    <section>Main content</section>
    <aside>Sidebar</aside>
  </main>
  <footer>Footer</footer>
</body>
</html>`;
  } else if (val === "grid") {
    tpl = `<!DOCTYPE html>
<html lang="ka">
<head>
  <meta charset="UTF-8">
  <title>Grid gallery</title>
</head>
<body>
  <h1>Gallery</h1>
  <div class="grid">
    <div class="item">1</div>
    <div class="item">2</div>
    <div class="item">3</div>
    <div class="item">4</div>
  </div>
</body>
</html>`;
  }

  files[currentIndex].path = "main.html";
  files[currentIndex].content = tpl;
  models[currentIndex].setValue(tpl);
  document.getElementById("current-file-name").textContent = files[currentIndex].path;
  projects.list[projects.active] = cloneFiles(files);
  saveProjects();
  setStatus("Template inserted.");
};

// Task checker – elementary rules
window.checkTask = function () {
  const html =
    files.find(f => f.path.toLowerCase().endsWith(".html")) || files[0];
  const src = (html.content || "").toLowerCase();

  const checks = [];
  checks.push({
    label: "<header>",
    ok: src.includes("<header")
  });
  checks.push({
    label: "<nav>",
    ok: src.includes("<nav")
  });
  checks.push({
    label: "<footer>",
    ok: src.includes("<footer")
  });
  checks.push({
    label: "Flex ან Grid",
    ok: src.includes("display:flex") || src.includes("display: grid")
  });

  let msg = "Task check:\n";
  checks.forEach(c => {
    msg += (c.ok ? "✅ " : "❌ ") + c.label + "\n";
  });

  alert(msg);
  setStatus("Task checked.");
};

// Share JSON
window.generateShare = function () {
  const payload = {
    project: projects.active,
    files: files
  };
  const txt = JSON.stringify(payload, null, 2);
  shareTextEl.value = txt;
  shareTextEl.focus();
  shareTextEl.select();
  setStatus("Share JSON generated.");
};

// New project
window.newProject = function () {
  const name = prompt("Project name:", "Project " + (Object.keys(projects.list).length + 1));
  if (!name) return;
  if (projects.list[name]) {
    alert("ასეთი პროექტის სახელი უკვე არსებობს.");
    return;
  }
  projects.list[name] = cloneFiles(defaultFiles);
  projects.active = name;
  saveProjects();
  location.reload();
};

// Switch project (status bar select – change handler)
document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "project-select") {
    const name = e.target.value;
    if (!projects.list[name]) return;
    window.__saveCurrentFile && window.__saveCurrentFile();
    projects.active = name;
    saveProjects();
    location.reload();
  }
});
