export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const needsAuth =
      url.pathname === "/" ||
      url.pathname === "/upload" ||
      url.pathname === "/api/list" ||
      url.pathname === "/api/list-folders" ||
      url.pathname === "/api/upload" ||
      url.pathname === "/api/delete" ||
      url.pathname === "/api/delete-many" ||
      url.pathname === "/api/create-folder" ||
      url.pathname === "/api/move" ||
      url.pathname === "/api/rename" ||
      url.pathname === "/api/note/get" ||
      url.pathname === "/api/note/set" ||
      url.pathname.startsWith("/p/") ||
      url.pathname.startsWith("/sf/private/");

    if (needsAuth) {
      const authResp = checkBasicAuth(request, env);
      if (authResp) return authResp;
    }

    if (request.method === "GET" && url.pathname === "/") {
      return Response.redirect(url.origin + "/upload", 302);
    }

    if (request.method === "GET" && url.pathname === "/upload") {
      return new Response(appPageHtml(), {
        headers: baseHtmlHeaders(),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/list") {
      const mode = url.searchParams.get("mode") === "public" ? "public" : "private";
      const folder = sanitizeFolderPath(url.searchParams.get("folder") || "");
      const query = (url.searchParams.get("q") || "").trim().toLowerCase();
      const data = await listFolderView(env, request, mode, folder, query);
      return json(data);
    }

    if (request.method === "GET" && url.pathname === "/api/list-folders") {
      const mode = url.searchParams.get("mode") === "public" ? "public" : "private";
      const listed = await env.FILES.list({ prefix: `${mode}/` });
      const objects = listed.objects || [];

      const folderSet = new Set([""]);
      for (const obj of objects) {
        const key = obj.key.replace(new RegExp(`^${mode}/`), "");
        if (isMetaKey(obj.key)) continue;
        const parts = key.split("/").filter(Boolean);
        if (parts.length >= 2) {
          let acc = "";
          for (let i = 0; i < parts.length - 1; i++) {
            if (parts[i] === ".folder") continue;
            acc = acc ? `${acc}/${parts[i]}` : parts[i];
            folderSet.add(acc);
          }
        }
      }

      return json({
        ok: true,
        folders: [...folderSet].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/create-folder") {
      try {
        const body = await request.json();
        const mode = body?.mode === "public" ? "public" : "private";
        const currentFolder = sanitizeFolderPath(body?.folder || "");
        const folderName = sanitizeFolderName(body?.name || "");

        if (!folderName) {
          return json({ error: "Folder name is required" }, 400);
        }

        const fullFolder = joinFolder(currentFolder, folderName);
        const markerKey = `${mode}/${fullFolder}/.folder`;

        await env.FILES.put(markerKey, new Uint8Array([]), {
          httpMetadata: { contentType: "application/octet-stream" },
        });

        return json({ ok: true, folder: fullFolder, key: markerKey });
      } catch (err) {
        return json({ error: "Create folder failed", detail: getErrorMessage(err) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/upload") {
      try {
        const form = await request.formData();
        const mode = form.get("mode") === "public" ? "public" : "private";
        const folder = sanitizeFolderPath(form.get("folder") || "");
        const files = form.getAll("files");

        if (!files.length) {
          return json({ error: "No files uploaded" }, 400);
        }

        const uploaded = [];

        for (const item of files) {
          if (!item || typeof item === "string") continue;

          const originalName = item.name || "upload.bin";
          const relPathRaw = form.get(`relpath:${originalName}`) || "";
          const relPath = sanitizeRelativeUploadPath(String(relPathRaw));
          const safeName = sanitizeFilename(originalName);

          let objectPath = folder ? folder : "";
          if (relPath) {
            const cleanRelPath = sanitizeRelativeUploadPath(relPath);
            objectPath = joinFolder(objectPath, cleanRelPath);
          } else {
            objectPath = joinFolder(objectPath, safeName);
          }

          const objectKey = `${mode}/${objectPath}`;
          const buffer = await item.arrayBuffer();

          await env.FILES.put(objectKey, buffer, {
            httpMetadata: { contentType: item.type || "application/octet-stream" },
          });

          const noteKey = noteObjectKey(mode, objectPath);
          const existingNote = await env.FILES.get(noteKey);
          if (!existingNote) {
            await env.FILES.put(
              noteKey,
              JSON.stringify({ note: "", updatedAt: new Date().toISOString() }),
              { httpMetadata: { contentType: "application/json; charset=utf-8" } }
            );
          }

          uploaded.push({
            name: originalName,
            key: objectKey,
            shortKey: objectPath,
            url:
              mode === "private"
                ? `${url.origin}/p/${encodeURIComponent(objectPath)}`
                : `${url.origin}/f/${encodeURIComponent(objectPath)}`,
          });
        }

        return json({
          ok: true,
          count: uploaded.length,
          uploaded,
          firstUrl: uploaded[0]?.url || "",
        });
      } catch (err) {
        return json({ error: "Upload failed", detail: getErrorMessage(err) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/delete") {
      try {
        const body = await request.json();
        const key = body?.key;
        if (!key || typeof key !== "string") {
          return json({ error: "Missing key" }, 400);
        }
        await deleteEntry(env, key);
        return json({ ok: true, deleted: key });
      } catch (err) {
        return json({ error: "Delete failed", detail: getErrorMessage(err) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/delete-many") {
      try {
        const body = await request.json();
        const keys = Array.isArray(body?.keys) ? body.keys : [];
        if (!keys.length) return json({ error: "No keys provided" }, 400);

        for (const key of keys) {
          await deleteEntry(env, key);
        }

        return json({ ok: true, deleted: keys.length });
      } catch (err) {
        return json({ error: "Bulk delete failed", detail: getErrorMessage(err) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/move") {
      try {
        const body = await request.json();
        const mode = body?.mode === "public" ? "public" : "private";
        const keys = Array.isArray(body?.keys) ? body.keys : [];
        const targetFolder = sanitizeFolderPath(body?.targetFolder || "");

        if (!keys.length) return json({ error: "No items selected" }, 400);

        for (const key of keys) {
          await moveEntry(env, mode, key, targetFolder);
        }

        return json({ ok: true, moved: keys.length });
      } catch (err) {
        return json({ error: "Move failed", detail: getErrorMessage(err) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/rename") {
      try {
        const body = await request.json();
        const mode = body?.mode === "public" ? "public" : "private";
        const key = String(body?.key || "");
        const newNameRaw = String(body?.newName || "");
        const newName = sanitizeRenameInput(newNameRaw);

        if (!key) return json({ error: "Missing key" }, 400);
        if (!newName) return json({ error: "New name is required" }, 400);

        const result = await renameEntry(env, mode, key, newName);
        return json({ ok: true, ...result });
      } catch (err) {
        return json({ error: "Rename failed", detail: getErrorMessage(err) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/note/get") {
      try {
        const body = await request.json();
        const mode = body?.mode === "public" ? "public" : "private";
        const shortKey = normalizePath(body?.shortKey || "");
        if (!shortKey) return json({ error: "Missing shortKey" }, 400);

        const note = await readNote(env, mode, shortKey);
        return json({ ok: true, note });
      } catch (err) {
        return json({ error: "Get note failed", detail: getErrorMessage(err) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/note/set") {
      try {
        const body = await request.json();
        const mode = body?.mode === "public" ? "public" : "private";
        const shortKey = normalizePath(body?.shortKey || "");
        const note = String(body?.note || "");
        if (!shortKey) return json({ error: "Missing shortKey" }, 400);

        await writeNote(env, mode, shortKey, note);
        return json({ ok: true });
      } catch (err) {
        return json({ error: "Set note failed", detail: getErrorMessage(err) }, 500);
      }
    }

    if (request.method === "GET" && url.pathname.startsWith("/f/")) {
      const key = decodeURIComponent(url.pathname.slice(3));
      return serveFile(env, `public/${normalizePath(key)}`);
    }

    if (request.method === "GET" && url.pathname.startsWith("/p/")) {
      const key = decodeURIComponent(url.pathname.slice(3));
      return serveFile(env, `private/${normalizePath(key)}`);
    }

    if (request.method === "GET" && url.pathname.startsWith("/sf/public/")) {
      const sharedRoot = sanitizeFolderPath(
        decodeURIComponent(url.pathname.slice("/sf/public/".length))
      );
      const relative = sanitizeFolderPath(url.searchParams.get("dir") || "");
      const query = (url.searchParams.get("q") || "").trim().toLowerCase();
      const view = url.searchParams.get("view") === "gallery" ? "gallery" : "list";

      const data = await listSharedFolderView(env, request, "public", sharedRoot, relative, query);

      return new Response(folderSharePageHtml(data, "public", sharedRoot, relative, view, query), {
        headers: baseHtmlHeaders(),
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/sf/private/")) {
      const sharedRoot = sanitizeFolderPath(
        decodeURIComponent(url.pathname.slice("/sf/private/".length))
      );
      const relative = sanitizeFolderPath(url.searchParams.get("dir") || "");
      const query = (url.searchParams.get("q") || "").trim().toLowerCase();
      const view = url.searchParams.get("view") === "gallery" ? "gallery" : "list";

      const data = await listSharedFolderView(env, request, "private", sharedRoot, relative, query);

      return new Response(folderSharePageHtml(data, "private", sharedRoot, relative, view, query), {
        headers: baseHtmlHeaders(),
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

function baseHtmlHeaders() {
  return {
    "content-type": "text/html; charset=UTF-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

async function listFolderView(env, request, mode, folder, query) {
  const url = new URL(request.url);
  const scanFolder = query ? "" : folder;
  const prefix = scanFolder ? `${mode}/${scanFolder}/` : `${mode}/`;
  const listed = await env.FILES.list({ prefix });
  const objects = listed.objects || [];

  const folders = new Map();
  const files = [];

  for (const obj of objects) {
    const fullKey = obj.key;
    if (isMetaKey(fullKey)) continue;
    if (!fullKey.startsWith(`${mode}/`)) continue;

    const shortKey = fullKey.replace(new RegExp(`^${mode}/`), "");
    if (!shortKey) continue;

    const inCurrentFolder =
      !folder ||
      shortKey.startsWith(folder + "/") ||
      shortKey === folder;

    if (inCurrentFolder) {
      const relativeToCurrent = folder
        ? shortKey.slice(folder.length).replace(/^\/+/, "")
        : shortKey;

      const parts = relativeToCurrent.split("/").filter(Boolean);
      if (parts.length > 1) {
        const subfolder = parts[0];
        const folderPath = joinFolder(folder, subfolder);
        const searchText = [subfolder, folderPath, folder].join(" ").toLowerCase();
        if (!query || searchText.includes(query)) {
          if (!folders.has(folderPath)) {
            folders.set(folderPath, {
              name: subfolder,
              folder: folderPath,
              key: `${mode}/${folderPath}/.folder`,
              mode,
              kind: "folder",
              shareUrl:
                mode === "private"
                  ? `${url.origin}/sf/private/${encodeURIComponent(folderPath)}`
                  : `${url.origin}/sf/public/${encodeURIComponent(folderPath)}`,
            });
          }
        }
      }
    }

    const noteText = await readNote(env, mode, shortKey);
    const haystack = [shortKey.split("/").pop() || "", shortKey, noteText].join(" ").toLowerCase();

    if (query) {
      if (!haystack.includes(query)) continue;
    } else {
      const parent = shortKey.split("/").slice(0, -1).join("/");
      if (parent !== folder) continue;
    }

    if (shortKey.endsWith("/.folder")) continue;

    const fileUrl =
      mode === "private"
        ? `${url.origin}/p/${encodeURIComponent(shortKey)}`
        : `${url.origin}/f/${encodeURIComponent(shortKey)}`;

    const name = shortKey.split("/").pop() || shortKey;

    files.push({
      name,
      key: `${mode}/${shortKey}`,
      shortKey,
      mode,
      url: fileUrl,
      size: obj.size ?? 0,
      uploaded: obj.uploaded ?? null,
      kind: "file",
      note: noteText,
    });
  }

  if (query) {
    const allFolders = new Set();
    for (const obj of objects) {
      const fullKey = obj.key;
      if (isMetaKey(fullKey)) continue;
      if (!fullKey.startsWith(`${mode}/`)) continue;
      const shortKey = fullKey.replace(new RegExp(`^${mode}/`), "");
      const parts = shortKey.split("/").filter(Boolean);
      if (parts.length >= 2) {
        let acc = "";
        for (let i = 0; i < parts.length - 1; i++) {
          acc = acc ? `${acc}/${parts[i]}` : parts[i];
          allFolders.add(acc);
        }
      }
    }

    for (const f of allFolders) {
      const leaf = f.split("/").pop() || f;
      const s = [leaf, f].join(" ").toLowerCase();
      if (s.includes(query) && !folders.has(f)) {
        folders.set(f, {
          name: leaf,
          folder: f,
          key: `${mode}/${f}/.folder`,
          mode,
          kind: "folder",
          shareUrl:
            mode === "private"
              ? `${url.origin}/sf/private/${encodeURIComponent(f)}`
              : `${url.origin}/sf/public/${encodeURIComponent(f)}`,
        });
      }
    }
  }

  files.sort((a, b) => {
    const at = a.uploaded ? new Date(a.uploaded).getTime() : 0;
    const bt = b.uploaded ? new Date(b.uploaded).getTime() : 0;
    return bt - at;
  });

  return {
    ok: true,
    mode,
    folder,
    breadcrumbs: buildBreadcrumbs(folder),
    folders: [...folders.values()].sort((a, b) => a.folder.localeCompare(b.folder, "zh-Hans-CN")),
    files,
  };
}

async function listSharedFolderView(env, request, mode, sharedRoot, relativeDir, query) {
  const url = new URL(request.url);
  const safeSharedRoot = sanitizeFolderPath(sharedRoot || "");
  const safeRelative = sanitizeFolderPath(relativeDir || "");
  const currentFolder = joinFolder(safeSharedRoot, safeRelative);
  const prefix = currentFolder ? `${mode}/${currentFolder}/` : `${mode}/`;

  const listed = await env.FILES.list({ prefix });
  const objects = listed.objects || [];

  const folders = new Map();
  const files = [];

  for (const obj of objects) {
    const fullKey = obj.key;
    if (isMetaKey(fullKey)) continue;

    const relative = fullKey.slice(prefix.length);
    if (!relative) continue;

    const parts = relative.split("/").filter(Boolean);
    if (!parts.length) continue;

    if (parts.length > 1) {
      const subfolder = parts[0];
      const fullFolderPath = joinFolder(currentFolder, subfolder);

      if (safeSharedRoot && !(fullFolderPath === safeSharedRoot || fullFolderPath.startsWith(safeSharedRoot + "/"))) {
        continue;
      }

      const searchText = [subfolder, fullFolderPath].join(" ").toLowerCase();
      if (query && !searchText.includes(query)) continue;

      if (!folders.has(subfolder)) {
        const relFromRoot = relativeFromRoot(safeSharedRoot, fullFolderPath);
        folders.set(subfolder, {
          name: subfolder,
          folder: fullFolderPath,
          relFolder: relFromRoot,
          shareUrl:
            mode === "private"
              ? `${url.origin}/sf/private/${encodeURIComponent(safeSharedRoot)}?dir=${encodeURIComponent(relFromRoot)}`
              : `${url.origin}/sf/public/${encodeURIComponent(safeSharedRoot)}?dir=${encodeURIComponent(relFromRoot)}`
        });
      }
      continue;
    }

    if (parts[0] === ".folder") continue;

    const name = parts[0];
    const shortKey = joinFolder(currentFolder, name);

    if (safeSharedRoot && !(shortKey === safeSharedRoot || shortKey.startsWith(safeSharedRoot + "/"))) {
      continue;
    }

    const fileUrl =
      mode === "private"
        ? `${url.origin}/p/${encodeURIComponent(shortKey)}`
        : `${url.origin}/f/${encodeURIComponent(shortKey)}`;

    const noteText = await readNote(env, mode, shortKey);
    const searchText = [name, shortKey, noteText].join(" ").toLowerCase();
    if (query && !searchText.includes(query)) continue;

    files.push({
      name,
      shortKey,
      url: fileUrl,
      size: obj.size ?? 0,
      uploaded: obj.uploaded ?? null,
      note: noteText,
    });
  }

  files.sort((a, b) => {
    const at = a.uploaded ? new Date(a.uploaded).getTime() : 0;
    const bt = b.uploaded ? new Date(b.uploaded).getTime() : 0;
    return bt - at;
  });

  return {
    ok: true,
    mode,
    sharedRoot: safeSharedRoot,
    relativeDir: safeRelative,
    folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN")),
    files,
  };
}

async function renameEntry(env, mode, key, newName) {
  if (!key.startsWith(`${mode}/`)) throw new Error("Invalid mode/key");

  if (key.endsWith("/.folder")) {
    const folderPath = key.replace(new RegExp(`^${mode}/`), "").replace(/\/\.folder$/, "");
    const parent = folderPath.split("/").slice(0, -1).join("/");
    const newFolderPath = parent ? `${parent}/${sanitizeFolderName(newName)}` : sanitizeFolderName(newName);

    const listPrefix = `${mode}/${folderPath}/`;
    const listed = await env.FILES.list({ prefix: listPrefix });
    const objects = listed.objects || [];

    for (const obj of objects) {
      const rel = obj.key.slice(listPrefix.length);
      const newKey = `${mode}/${newFolderPath}/${rel}`;
      const content = await env.FILES.get(obj.key);
      if (content) {
        await env.FILES.put(newKey, content.body, {
          httpMetadata: content.httpMetadata,
          customMetadata: content.customMetadata,
        });
        await env.FILES.delete(obj.key);
      }
    }

    const noteList = await env.FILES.list({ prefix: `__meta__/notes/${mode}/` });
    for (const obj of noteList.objects || []) {
      const encodedOldShort = obj.key.replace(`__meta__/notes/${mode}/`, "").replace(/\.json$/, "");
      const oldShortKey = decodeURIComponent(encodedOldShort);
      if (oldShortKey === folderPath || oldShortKey.startsWith(folderPath + "/")) {
        const rel = oldShortKey.slice(folderPath.length).replace(/^\/+/, "");
        const newShortKey = joinFolder(newFolderPath, rel);
        const noteBody = await env.FILES.get(obj.key);
        if (noteBody) {
          await env.FILES.put(noteObjectKey(mode, newShortKey), noteBody.body, {
            httpMetadata: noteBody.httpMetadata,
            customMetadata: noteBody.customMetadata,
          });
          await env.FILES.delete(obj.key);
        }
      }
    }

    return { type: "folder", oldKey: key, newKey: `${mode}/${newFolderPath}/.folder` };
  }

  const shortKey = key.replace(new RegExp(`^${mode}/`), "");
  const parts = shortKey.split("/");
  const parent = parts.slice(0, -1).join("/");
  const extMatch = parts[parts.length - 1].match(/(\.[^.]*)$/);
  const ext = extMatch ? extMatch[1] : "";
  const cleanNewName = sanitizeFilename(newName);
  const finalName = ext && !cleanNewName.endsWith(ext) ? cleanNewName + ext : cleanNewName;
  const newShortKey = parent ? `${parent}/${finalName}` : finalName;
  const newKey = `${mode}/${newShortKey}`;

  const content = await env.FILES.get(key);
  if (!content) throw new Error("File not found");

  await env.FILES.put(newKey, content.body, {
    httpMetadata: content.httpMetadata,
    customMetadata: content.customMetadata,
  });
  await env.FILES.delete(key);

  const note = await readNote(env, mode, shortKey);
  await writeNote(env, mode, newShortKey, note);
  await deleteNote(env, mode, shortKey);

  return { type: "file", oldKey: key, newKey };
}

async function moveEntry(env, mode, key, targetFolder) {
  if (!key.startsWith(`${mode}/`)) return;

  if (key.endsWith("/.folder")) {
    const folderPath = key.replace(new RegExp(`^${mode}/`), "").replace(/\/\.folder$/, "");
    const listPrefix = `${mode}/${folderPath}/`;
    const listed = await env.FILES.list({ prefix: listPrefix });
    const objects = listed.objects || [];
    const folderName = folderPath.split("/").filter(Boolean).pop() || "folder";
    const newBase = targetFolder ? `${targetFolder}/${folderName}` : folderName;

    for (const obj of objects) {
      const rel = obj.key.slice(listPrefix.length);
      const newKey = `${mode}/${newBase}/${rel}`;
      const content = await env.FILES.get(obj.key);
      if (content) {
        await env.FILES.put(newKey, content.body, {
          httpMetadata: content.httpMetadata,
          customMetadata: content.customMetadata,
        });
        await env.FILES.delete(obj.key);
      }
    }

    const noteList = await env.FILES.list({ prefix: `__meta__/notes/${mode}/` });
    for (const obj of noteList.objects || []) {
      const encodedShort = obj.key.replace(`__meta__/notes/${mode}/`, "").replace(/\.json$/, "");
      const shortKey = decodeURIComponent(encodedShort);
      if (shortKey === folderPath || shortKey.startsWith(folderPath + "/")) {
        const rel = shortKey.slice(folderPath.length).replace(/^\/+/, "");
        const newShortKey = joinFolder(newBase, rel);
        const noteBody = await env.FILES.get(obj.key);
        if (noteBody) {
          await env.FILES.put(noteObjectKey(mode, newShortKey), noteBody.body, {
            httpMetadata: noteBody.httpMetadata,
            customMetadata: noteBody.customMetadata,
          });
          await env.FILES.delete(obj.key);
        }
      }
    }

    return;
  }

  const shortKey = key.replace(new RegExp(`^${mode}/`), "");
  const name = shortKey.split("/").pop();
  const newShortKey = targetFolder ? `${targetFolder}/${name}` : name;
  const newKey = `${mode}/${newShortKey}`;

  const content = await env.FILES.get(key);
  if (!content) return;

  await env.FILES.put(newKey, content.body, {
    httpMetadata: content.httpMetadata,
    customMetadata: content.customMetadata,
  });
  await env.FILES.delete(key);

  const note = await readNote(env, mode, shortKey);
  await writeNote(env, mode, newShortKey, note);
  await deleteNote(env, mode, shortKey);
}

async function deleteEntry(env, key) {
  if (key.endsWith("/.folder")) {
    const prefix = key.replace(/\.folder$/, "");
    const listed = await env.FILES.list({ prefix });
    for (const obj of listed.objects || []) {
      await env.FILES.delete(obj.key);
      if (!isMetaKey(obj.key)) {
        const m = obj.key.match(/^(public|private)\/(.+)$/);
        if (m) await deleteNote(env, m[1], m[2]);
      }
    }
    return;
  }

  await env.FILES.delete(key);
  if (!isMetaKey(key)) {
    const m = key.match(/^(public|private)\/(.+)$/);
    if (m) await deleteNote(env, m[1], m[2]);
  }
}

async function serveFile(env, objectKey) {
  const obj = await env.FILES.get(objectKey);
  if (!obj) {
    return new Response("File not found", {
      status: 404,
      headers: {
        "x-robots-tag": "noindex, nofollow, noarchive",
        "referrer-policy": "no-referrer",
      },
    });
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=3600");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "content-disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(objectKey.split("/").pop() || "download")}`
  );

  return new Response(obj.body, { headers });
}

function noteObjectKey(mode, shortKey) {
  return `__meta__/notes/${mode}/${encodeURIComponent(shortKey)}.json`;
}
function isMetaKey(key) {
  return key.startsWith("__meta__/");
}

async function readNote(env, mode, shortKey) {
  const obj = await env.FILES.get(noteObjectKey(mode, shortKey));
  if (!obj) return "";
  try {
    const text = await obj.text();
    const parsed = JSON.parse(text);
    return String(parsed.note || "");
  } catch {
    return "";
  }
}

async function writeNote(env, mode, shortKey, note) {
  await env.FILES.put(
    noteObjectKey(mode, shortKey),
    JSON.stringify({ note, updatedAt: new Date().toISOString() }),
    { httpMetadata: { contentType: "application/json; charset=utf-8" } }
  );
}

async function deleteNote(env, mode, shortKey) {
  await env.FILES.delete(noteObjectKey(mode, shortKey));
}

function checkBasicAuth(request, env) {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Basic ")) {
    return new Response("Authentication required", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Private File Share"',
        "cache-control": "no-store",
      },
    });
  }

  try {
    const encoded = auth.slice(6);
    const decoded = atob(encoded);
    const idx = decoded.indexOf(":");
    const user = idx >= 0 ? decoded.slice(0, idx) : "";
    const pass = idx >= 0 ? decoded.slice(idx + 1) : "";

    if (user !== env.APP_USER || pass !== env.APP_PASS) {
      return new Response("Forbidden", {
        status: 403,
        headers: { "cache-control": "no-store" },
      });
    }
    return null;
  } catch {
    return new Response("Invalid auth header", {
      status: 400,
      headers: { "cache-control": "no-store" },
    });
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow, noarchive",
    },
  });
}

function normalizePath(v) {
  return String(v || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/+/g, "/");
}
function sanitizeFolderPath(v) {
  return normalizePath(v).split("/").map(sanitizeFolderName).filter(Boolean).join("/");
}
function sanitizeFolderName(v) {
  return String(v || "").normalize("NFKC").replace(/[\/\\:*?"<>|]+/g, "").replace(/\s+/g, " ").trim();
}
function sanitizeFilename(name) {
  return (String(name || "upload.bin").normalize("NFKC").replace(/[\/\\:*?"<>|]+/g, "").replace(/\s+/g, " ").trim() || "upload.bin");
}
function sanitizeRenameInput(name) {
  return String(name || "").normalize("NFKC").replace(/[\/\\:*?"<>|]+/g, "").replace(/\s+/g, " ").trim();
}
function sanitizeRelativeUploadPath(v) {
  const normalized = normalizePath(v);
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return "";
  const clean = parts.map((part, idx) => idx === parts.length - 1 ? sanitizeFilename(part) : sanitizeFolderName(part)).filter(Boolean);
  return clean.join("/");
}
function joinFolder(base, child) {
  return [base, child].filter(Boolean).join("/");
}
function relativeFromRoot(root, full) {
  if (!root) return full;
  if (full === root) return "";
  if (full.startsWith(root + "/")) return full.slice(root.length + 1);
  return "";
}
function buildBreadcrumbs(folder) {
  const parts = folder ? folder.split("/").filter(Boolean) : [];
  const crumbs = [{ name: "Root", folder: "" }];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push({ name: part, folder: acc });
  }
  return crumbs;
}
function getErrorMessage(err) {
  return String(err && err.message ? err.message : err);
}
function formatSizeSimple(bytes) {
  if (!bytes && bytes !== 0) return "-";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
}
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function folderSharePageHtml(data, mode, sharedRoot, relativeDir, view, query) {
  const crumbs = buildBreadcrumbs(relativeDir || "");
  const breadcrumbHtml = crumbs
    .map((c, idx) => {
      const href = `/sf/${mode}/${encodeURIComponent(sharedRoot)}?dir=${encodeURIComponent(c.folder)}&view=${encodeURIComponent(view)}&q=${encodeURIComponent(query || "")}`;
      const label = escapeHtml(idx === 0 ? "Root" : c.name);
      return idx === crumbs.length - 1 ? `<span>${label}</span>` : `<a href="${href}">${label}</a>`;
    })
    .join(" / ");

  const foldersHtml = (data.folders || [])
    .map((f) => {
      const href = `/sf/${mode}/${encodeURIComponent(sharedRoot)}?dir=${encodeURIComponent(f.relFolder || "")}&view=${encodeURIComponent(view)}&q=${encodeURIComponent(query || "")}`;
      return `<div class="item"><div>📁 <a href="${href}">${escapeHtml(f.name)}</a></div><div class="muted">Folder</div></div>`;
    })
    .join("");

  const filesHtml = (data.files || [])
    .map((f) => {
      const lower = f.name.toLowerCase();
      const isImage = /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(lower);
      const isVideo = /\.(mp4|webm|ogg|mov|m4v)$/i.test(lower);
      const preview = isImage
        ? `<img src="${f.url}" style="width:64px;height:64px;object-fit:cover;border-radius:10px;background:#f8fafc">`
        : isVideo
          ? `<video src="${f.url}" style="width:120px;height:68px;border-radius:10px;background:#000" muted></video>`
          : `📄`;

      return `
        <div class="item">
          <div style="display:flex;gap:12px;align-items:flex-start">
            <div>${preview}</div>
            <div>
              <div><a href="${f.url}" target="_blank">${escapeHtml(f.name)}</a></div>
              ${f.note ? `<div class="muted" style="margin-top:4px">${escapeHtml(f.note)}</div>` : ``}
            </div>
          </div>
          <div class="muted">
            ${escapeHtml(formatSizeSimple(f.size))}
            · <a href="${f.url}" target="_blank" download>Download</a>
          </div>
        </div>
      `;
    })
    .join("");

  const galleryItems = (data.files || [])
    .filter((f) => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f.name))
    .map((f) => {
      return `<a class="gitem" href="${f.url}" target="_blank"><img src="${f.url}" alt=""><div>${escapeHtml(f.name)}</div></a>`;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Shared folder</title>
<style>
body{font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f8fb;margin:0;padding:24px;color:#111}
.wrap{max-width:1100px;margin:0 auto;background:#fff;border:1px solid #e5eaf2;border-radius:20px;padding:24px}
h1{margin:0 0 8px;font-size:28px}
.crumbs{margin:0 0 20px;color:#667085}
a{color:#2563eb;text-decoration:none}
.top{display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:18px}
.controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
input[type=text]{padding:10px 12px;border:1px solid #d0d7e2;border-radius:12px}
button{padding:10px 14px;border:0;border-radius:12px;background:#eef2f7;cursor:pointer;font-weight:700}
.item{padding:14px 0;border-bottom:1px solid #eef2f7;display:flex;justify-content:space-between;gap:16px}
.muted{color:#667085}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}
.gitem{display:block;border:1px solid #e5eaf2;border-radius:16px;padding:10px;background:#fff}
.gitem img{display:block;width:100%;height:180px;object-fit:cover;border-radius:10px;background:#f8fafc;margin-bottom:10px}
</style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>Shared folder</h1>
        <div class="crumbs">${breadcrumbHtml}</div>
        <div class="muted">Shared root: ${escapeHtml(sharedRoot || "/")}</div>
      </div>
      <div class="controls">
        <a href="/sf/${mode}/${encodeURIComponent(sharedRoot)}?dir=${encodeURIComponent(relativeDir || "")}&view=list&q=${encodeURIComponent(query || "")}"><button>List</button></a>
        <a href="/sf/${mode}/${encodeURIComponent(sharedRoot)}?dir=${encodeURIComponent(relativeDir || "")}&view=gallery&q=${encodeURIComponent(query || "")}"><button>Gallery</button></a>
        <form method="GET" action="/sf/${mode}/${encodeURIComponent(sharedRoot)}" style="display:flex;gap:10px">
          <input type="hidden" name="dir" value="${escapeHtml(relativeDir || "")}">
          <input type="hidden" name="view" value="${escapeHtml(view)}">
          <input type="text" name="q" value="${escapeHtml(query || "")}" placeholder="Search shared folder">
          <button type="submit">Search</button>
        </form>
      </div>
    </div>
    ${foldersHtml || ""}
    ${view === "gallery" ? `<div class="gallery">${galleryItems || `<div class="muted">No images.</div>`}</div>` : filesHtml}
    ${!foldersHtml && !filesHtml && !galleryItems ? `<div class="muted">This folder is empty.</div>` : ``}
  </div>
</body>
</html>`;
}

function appPageHtml() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Private File Share</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
:root{
  --bg:#f6f8fb;--card:#ffffff;--line:#e5eaf2;--text:#101828;--muted:#667085;
  --blue:#2563eb;--navy:#0f172a;--danger:#dc2626;--danger-soft:#fee2e2;
  --shadow:0 12px 32px rgba(16,24,40,.08);--radius:18px;
}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,Arial,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text)}
.app{max-width:1450px;margin:0 auto;padding:24px 16px 40px}
.header{margin-bottom:18px;display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
.header h1{margin:0;font-size:38px;letter-spacing:-.03em}
.header p{margin:8px 0 0;color:var(--muted);font-size:17px}
.lang-switch{display:flex;gap:8px}
.lang-btn{border:0;background:#eef2f7;color:#111827;border-radius:12px;padding:10px 14px;font-weight:800;cursor:pointer}
.lang-btn.active{background:#111827;color:#fff}
.layout{display:grid;grid-template-columns:260px 1fr;gap:18px}
.sidebar,.main{background:var(--card);border:1px solid var(--line);border-radius:24px;box-shadow:var(--shadow)}
.sidebar{padding:18px;height:fit-content;position:sticky;top:20px}
.brand{font-size:14px;color:var(--muted);margin-bottom:16px}
.nav-group{display:flex;flex-direction:column;gap:10px}
.side-btn{width:100%;border:0;background:#f3f6fb;color:#0f172a;border-radius:14px;padding:14px 16px;text-align:left;font-size:15px;font-weight:700;cursor:pointer}
.side-btn.active{background:#0f172a;color:#fff}
.side-note{margin-top:18px;padding:14px;border-radius:16px;background:#f8fafc;color:var(--muted);font-size:13px;line-height:1.45}
.main{padding:18px}
.toolbar{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.left-tools,.right-tools,.bulk-bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.btn{border:0;border-radius:14px;padding:12px 18px;font-size:15px;font-weight:800;cursor:pointer}
.btn-soft{background:#eef2f7;color:#111827}
.btn-primary{background:var(--blue);color:#fff}
.btn-danger{background:var(--danger-soft);color:#991b1b}
.bulk-wrap{display:none;margin:0 0 14px;padding:12px;border:1px solid var(--line);background:#f8fafc;border-radius:16px}
.bulk-wrap.show{display:block}
.pathbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:6px 18px 16px}
.crumb{border:0;background:transparent;color:var(--blue);cursor:pointer;font-size:14px;padding:0}
.crumb.current{color:#111827;font-weight:800;cursor:default}
.drop{border:2px dashed #bfd2f5;background:linear-gradient(180deg,#f8fbff,#f3f7ff);border-radius:24px;padding:34px 22px;text-align:center;transition:.18s ease}
.drop.drag{border-color:var(--blue);background:#eaf2ff}
.drop h2{margin:0 0 8px;font-size:34px;letter-spacing:-.03em}
.drop p{margin:0 0 18px;color:var(--muted);font-size:18px}
.upload-controls{display:flex;gap:14px;justify-content:center;align-items:center;flex-wrap:wrap}
.picker{position:relative;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;min-width:220px;height:62px;border-radius:18px;background:var(--navy);color:#fff;font-weight:900;font-size:18px;box-shadow:0 10px 24px rgba(15,23,42,.18);cursor:pointer;padding:0 22px}
.picker.secondary{background:#fff;color:#0f172a;border:1px solid var(--line);box-shadow:none}
.picker input{position:absolute;inset:0;opacity:0;cursor:pointer}
.selected{margin-top:12px;min-height:22px;color:#344054;font-size:14px}
.status{margin-top:14px;padding:14px 16px;background:#f8fafc;border:1px solid var(--line);border-radius:16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
.progress-wrap{margin-top:10px;display:none}
.progress-wrap.show{display:block}
.progress-bar{width:100%;height:14px;background:#e8edf5;border-radius:999px;overflow:hidden}
.progress-fill{height:100%;width:0%;background:linear-gradient(90deg,#2563eb,#60a5fa);transition:width .15s ease}
.progress-text{margin-top:6px;font-size:13px;color:var(--muted)}
.share{margin-top:14px;display:grid;grid-template-columns:1fr auto auto;gap:10px}
.share input{width:100%;border:1px solid var(--line);border-radius:16px;padding:14px 16px;font-size:14px}
.panel{border:1px solid var(--line);border-radius:22px;overflow:hidden;background:#fff}
.panel-head{padding:16px 18px;border-bottom:1px solid var(--line);font-weight:800;display:flex;justify-content:space-between;gap:10px;align-items:center}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fill,minmax(180px,1fr));
  gap:14px;
  padding:16px;
  min-height:88px;
}
.folder-card{
  border:1px solid var(--line);
  border-radius:18px;
  background:#fffdf7;
  padding:16px;
  cursor:pointer;
  transition:.15s ease;
}
.folder-card:hover{border-color:#f0c98e}
.folder-card.drop-target{
  border-color:var(--blue);
  background:#eef4ff;
  box-shadow:0 0 0 3px rgba(37,99,235,.10) inset;
}
.folder-top{font-size:30px;margin-bottom:10px}
.folder-name{font-weight:800;word-break:break-word}
.folder-sub{margin-top:6px;color:var(--muted);font-size:13px}
.table-wrap{overflow:auto}
table{width:100%;border-collapse:collapse}
th,td{border-bottom:1px solid var(--line);padding:12px 10px;text-align:left;vertical-align:top;font-size:14px}
th{background:#fafbfc;color:#667085;font-size:13px}
th.chk,td.chk{width:38px}
.name-cell{display:flex;gap:10px;align-items:flex-start;min-width:220px}
.icon{width:42px;height:42px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:#eef2ff;flex:0 0 auto;overflow:visible;position:relative}
.thumb{width:100%;height:100%;object-fit:cover;border-radius:14px;display:block}
.meta{color:var(--muted);font-size:12px;margin-top:3px}
.link-cell{max-width:240px;word-break:break-all}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.mini{border:0;border-radius:10px;padding:8px 10px;font-size:13px;font-weight:800;cursor:pointer;background:#eef2f7;color:#111827}
.mini.danger{background:var(--danger-soft);color:#991b1b}
.empty{padding:24px 18px;color:var(--muted)}
dialog{border:0;border-radius:20px;padding:0;width:min(520px,calc(100% - 24px));box-shadow:0 24px 60px rgba(0,0,0,.2)}
.modal{padding:20px}
.modal h3{margin:0 0 10px;font-size:24px}
.modal p{color:var(--muted);margin:0 0 14px}
.modal input,.modal select,.modal textarea{width:100%;border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:14px;font-size:14px}
.modal textarea{min-height:180px;resize:vertical}
.modal-actions{display:flex;justify-content:flex-end;gap:8px}
.search-box{display:flex;gap:10px;align-items:center}
.search-box input{border:1px solid var(--line);border-radius:12px;padding:10px 12px;font-size:14px;min-width:260px}
.note-preview{color:#667085;font-size:12px;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px}
.login-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:200}
.login-card{width:min(420px,calc(100% - 24px));background:#fff;border-radius:24px;padding:24px;box-shadow:0 24px 60px rgba(0,0,0,.25)}
.login-card h2{margin:0 0 8px}
.login-card p{margin:0 0 16px;color:var(--muted)}
.login-card input{width:100%;border:1px solid var(--line);border-radius:14px;padding:14px;font-size:16px;margin-bottom:12px}
.viewer-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.72);display:none;align-items:center;justify-content:center;z-index:220;padding:20px}
.viewer-backdrop.show{display:flex}
.viewer-card{max-width:min(96vw,1200px);max-height:92vh;background:#111;border-radius:20px;padding:16px;position:relative}
.viewer-close{position:absolute;top:10px;right:10px;background:#fff;border:0;border-radius:999px;padding:8px 12px;cursor:pointer;font-weight:800}
.viewer-card img,.viewer-card video{max-width:92vw;max-height:84vh;display:block;border-radius:12px}
.qr-box{display:flex;justify-content:center;padding:8px}
.qr-box img{width:220px;height:220px;background:#fff;border-radius:12px}
.floating-preview{
  position:fixed;
  top:0;
  left:0;
  width:300px;
  height:560px;
  background:#fff;
  border:1px solid var(--line);
  border-radius:26px;
  box-shadow:0 20px 48px rgba(16,24,40,.22);
  padding:10px;
  z-index:9999;
  display:none;
  pointer-events:none;
}
.floating-preview img,
.floating-preview video{
  width:100%;
  height:100%;
  object-fit:contain;
  border-radius:18px;
  background:#f8fafc;
}
@media (max-width:1100px){.layout{grid-template-columns:1fr}.sidebar{position:static}}
@media (max-width:720px){
  .header h1{font-size:30px}
  .drop h2{font-size:28px}
  .picker{min-width:180px;height:56px;font-size:16px}
  .share{grid-template-columns:1fr}
  .search-box input{min-width:160px}
  .floating-preview{width:220px;height:420px}
  .btn,.side-btn,.mini{font-size:14px}
}
</style>
</head>
<body>
<div id="loginOverlay" class="login-overlay">
  <div class="login-card">
    <h2 id="loginTitle">Enter</h2>
    <p id="loginHint">Unlock this app on this device.</p>
    <input id="loginInput" type="password" placeholder="Password" />
    <button id="loginBtn" class="btn btn-primary" type="button">Unlock</button>
  </div>
</div>

<div class="app" id="appRoot" style="filter:blur(2px);pointer-events:none">
  <div class="header">
    <div>
      <h1 id="title"></h1>
      <p id="subtitle"></p>
    </div>
    <div class="lang-switch">
      <button id="langZh" class="lang-btn active" type="button">中文</button>
      <button id="langEn" class="lang-btn" type="button">English</button>
    </div>
  </div>

  <div class="layout">
    <aside class="sidebar">
      <div class="brand" id="workspaceLabel"></div>
      <div class="nav-group">
        <button id="modePrivate" class="side-btn active" type="button"></button>
        <button id="modePublic" class="side-btn" type="button"></button>
        <button id="newFolderBtn" class="side-btn" type="button"></button>
        <button id="refreshBtn" class="side-btn" type="button"></button>
      </div>
      <div class="side-note" id="sideNote"></div>
    </aside>

    <main class="main">
      <div class="toolbar">
        <div class="left-tools">
          <strong id="currentModeLabel"></strong>
        </div>
        <div class="right-tools">
          <div class="search-box">
            <input id="searchInput" type="text" />
            <button id="searchBtn" class="btn btn-soft" type="button"></button>
          </div>
          <button id="uploadBtn" class="btn btn-primary" type="button"></button>
        </div>
      </div>

      <div id="bulkWrap" class="bulk-wrap">
        <div class="bulk-bar">
          <strong id="bulkSelectedText"></strong>
          <button id="selectAllBtn" class="btn btn-soft" type="button"></button>
          <button id="moveBtn" class="btn btn-soft" type="button"></button>
          <button id="deleteSelectedBtn" class="btn btn-danger" type="button"></button>
        </div>
      </div>

      <section id="drop" class="drop" style="margin-bottom:18px">
        <h2 id="dropTitle"></h2>
        <p id="dropSubtitle"></p>

        <div class="upload-controls">
          <label class="picker">
            <span id="chooseFilesText"></span>
            <input id="fileInput" type="file" multiple />
          </label>

          <label class="picker secondary">
            <span id="chooseFolderText"></span>
            <input id="folderInput" type="file" webkitdirectory directory multiple />
          </label>
        </div>

        <div id="selected" class="selected"></div>

        <div id="progressWrap" class="progress-wrap">
          <div class="progress-bar"><div id="progressFill" class="progress-fill"></div></div>
          <div id="progressText" class="progress-text">0%</div>
        </div>
      </section>

      <section class="panel" style="margin-bottom:18px">
        <div class="panel-head">
          <span id="foldersHead"></span>
          <button id="copyFolderShareBtn" class="mini" type="button"></button>
        </div>
        <div class="pathbar" id="breadcrumbs"></div>
        <div id="foldersGrid" class="grid"></div>
      </section>

      <div id="status" class="status">Waiting...</div>

      <div class="share">
        <input id="shareLink" type="text" readonly />
        <button id="copyLinkBtn" class="btn btn-soft" type="button"></button>
        <button id="clearSearchBtn" class="btn btn-soft" type="button"></button>
      </div>

      <section class="panel" style="margin-top:18px">
        <div class="panel-head" id="filesHead"></div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="chk"><input id="masterCheckbox" type="checkbox" /></th>
                <th id="thName"></th>
                <th id="thSize"></th>
                <th id="thUploaded"></th>
                <th id="thLink"></th>
                <th id="thActions"></th>
              </tr>
            </thead>
            <tbody id="tableBody">
              <tr><td colspan="6" class="empty">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  </div>
</div>

<dialog id="folderDialog">
  <form method="dialog" class="modal">
    <h3 id="newFolderTitle"></h3>
    <p id="newFolderHint"></p>
    <input id="folderNameInput" type="text" />
    <div class="modal-actions">
      <button class="btn btn-soft" value="cancel" id="cancelFolderBtn"></button>
      <button id="createFolderConfirm" class="btn btn-primary" value="default" type="button"></button>
    </div>
  </form>
</dialog>

<dialog id="moveDialog">
  <form method="dialog" class="modal">
    <h3 id="moveTitle"></h3>
    <p id="moveHint"></p>
    <select id="targetFolderSelect"></select>
    <div class="modal-actions">
      <button class="btn btn-soft" value="cancel" id="cancelMoveBtn"></button>
      <button id="confirmMoveBtn" class="btn btn-primary" value="default" type="button"></button>
    </div>
  </form>
</dialog>

<dialog id="renameDialog">
  <form method="dialog" class="modal">
    <h3 id="renameTitle"></h3>
    <p id="renameHint"></p>
    <input id="renameInput" type="text" />
    <div class="modal-actions">
      <button class="btn btn-soft" value="cancel" id="cancelRenameBtn"></button>
      <button id="confirmRenameBtn" class="btn btn-primary" value="default" type="button"></button>
    </div>
  </form>
</dialog>

<dialog id="noteDialog">
  <form method="dialog" class="modal">
    <h3 id="noteTitle"></h3>
    <p id="noteHint"></p>
    <textarea id="noteTextarea"></textarea>
    <div class="modal-actions">
      <button class="btn btn-soft" value="cancel" id="cancelNoteBtn"></button>
      <button id="saveNoteBtn" class="btn btn-primary" value="default" type="button"></button>
    </div>
  </form>
</dialog>

<dialog id="qrDialog">
  <form method="dialog" class="modal">
    <h3 id="qrTitle">QR Code</h3>
    <p id="qrHint">Scan or save this QR code.</p>
    <div class="qr-box"><img id="qrImage" alt="QR"></div>
    <input id="qrLinkInput" type="text" readonly />
    <div class="modal-actions">
      <button class="btn btn-soft" value="cancel">Close</button>
    </div>
  </form>
</dialog>

<div id="viewerBackdrop" class="viewer-backdrop">
  <div class="viewer-card">
    <button id="viewerClose" class="viewer-close" type="button">×</button>
    <div id="viewerContent"></div>
  </div>
</div>

<div id="floatingPreview" class="floating-preview">
  <div id="floatingPreviewInner"></div>
</div>

<script>
const APP_LOCK_KEY = "files_app_unlock_v1";
const APP_UNLOCK_PASSWORD = "alan";

const I18N = {
  zh: {
    title: "私人文件分享",
    subtitle: "更像 Dropbox 的界面，支持上传、文件夹、分享、二维码、灯箱预览、视频播放、备注搜索。",
    workspace: "工作区",
    privateFiles: "🔒 私密文件",
    publicFiles: "🌍 公开文件",
    newFolder: "📁 新建文件夹",
    refresh: "↻ 刷新",
    sideNote: "私密文件和私密文件夹分享仍然需要同一个密码。公开链接拿到即可访问。",
    privateMode: "私密模式",
    publicMode: "公开模式",
    uploadSelected: "上传选中文件",
    selectAll: "全选当前页",
    move: "移动",
    deleteSelected: "删除所选",
    root: "根目录",
    dropTitle: "把文件或整个文件夹拖到这里",
    dropSubtitle: "支持拖拽整个本地文件夹并尽量保留目录结构。",
    chooseFiles: "选择文件",
    chooseFolder: "选择文件夹",
    noFilesSelected: "未选择文件",
    copyLink: "复制链接",
    copyFolderShare: "复制文件夹分享链接",
    clearSearch: "清空搜索",
    folders: "文件夹",
    files: "文件",
    name: "名称",
    size: "大小",
    uploaded: "上传时间",
    link: "链接",
    actions: "操作",
    openFolder: "打开文件夹",
    copy: "复制",
    open: "打开",
    delete: "删除",
    rename: "重命名",
    notes: "备注",
    qr: "二维码",
    preview: "预览",
    play: "播放",
    shareFolder: "分享文件夹",
    waiting: "等待中...",
    selectedOne: "已选择 1 个文件",
    selectedMany: "已选择 {count} 个文件",
    pleaseChoose: "请先选择文件。",
    uploading: "正在上传 {count} 个文件...",
    uploadComplete: "上传完成：{count} 个文件",
    uploadCompleteCopied: "上传完成：{count} 个文件。首个链接已复制。",
    linkCopied: "链接已复制。",
    copyFailed: "复制失败。",
    deleted: "已删除。",
    deleteConfirm: "确定删除这些项目吗？",
    noSelection: "还没有选中任何项目。",
    noSubfolders: "此位置暂无子文件夹。",
    emptyFolder: "没有匹配结果或这个目录为空。",
    loading: "加载中...",
    failedLoad: "加载失败：",
    createFolderTitle: "新建文件夹",
    createFolderHint: "在当前目录中创建一个新文件夹。",
    folderNamePlaceholder: "文件夹名称",
    cancel: "取消",
    create: "创建",
    folderNameRequired: "文件夹名称不能为空。",
    folderCreated: "文件夹已创建。",
    moveTitle: "移动所选项目",
    moveHint: "选择目标文件夹。",
    moveDone: "移动完成。",
    currentSelection: "当前：{count} 项",
    searchPlaceholder: "搜索整个目录树（文件名 / 路径 / 备注）",
    search: "搜索",
    renameTitle: "重命名",
    renameHint: "输入新的名称。",
    renameDone: "重命名完成。",
    renameRequired: "新名称不能为空。",
    noteTitle: "编辑备注",
    noteHint: "可写入描述、标签、用途等。这些备注也会参与搜索。",
    noteSaved: "备注已保存。",
    save: "保存",
    loginTitle: "输入页面密码",
    loginHint: "这个密码只用于当前浏览器解锁页面。",
    loginFail: "密码错误",
    loginBtn: "解锁"
  },
  en: {
    title: "Private File Share",
    subtitle: "Dropbox-style UI with upload, folders, sharing, QR, lightbox preview, video player, and searchable notes.",
    workspace: "Workspace",
    privateFiles: "🔒 Private files",
    publicFiles: "🌍 Public files",
    newFolder: "📁 New folder",
    refresh: "↻ Refresh",
    sideNote: "Private files and private shared folders still require the same password. Public links can be opened by anyone with the link.",
    privateMode: "Private mode",
    publicMode: "Public mode",
    uploadSelected: "Upload selected",
    selectAll: "Select all on page",
    move: "Move",
    deleteSelected: "Delete selected",
    root: "Root",
    dropTitle: "Drop files or a whole folder here",
    dropSubtitle: "Dragging a local folder will preserve structure as much as the browser allows.",
    chooseFiles: "Choose files",
    chooseFolder: "Choose folder",
    noFilesSelected: "No files selected",
    copyLink: "Copy link",
    copyFolderShare: "Copy folder share link",
    clearSearch: "Clear search",
    folders: "Folders",
    files: "Files",
    name: "Name",
    size: "Size",
    uploaded: "Uploaded",
    link: "Link",
    actions: "Actions",
    openFolder: "Open folder",
    copy: "Copy",
    open: "Open",
    delete: "Delete",
    rename: "Rename",
    notes: "Notes",
    qr: "QR",
    preview: "Preview",
    play: "Play",
    shareFolder: "Share folder",
    waiting: "Waiting...",
    selectedOne: "Selected 1 file",
    selectedMany: "Selected {count} files",
    pleaseChoose: "Please choose files first.",
    uploading: "Uploading {count} file(s)...",
    uploadComplete: "Upload complete: {count} file(s)",
    uploadCompleteCopied: "Upload complete: {count} file(s). First link copied.",
    linkCopied: "Link copied.",
    copyFailed: "Copy failed.",
    deleted: "Deleted.",
    deleteConfirm: "Delete selected items?",
    noSelection: "No items selected.",
    noSubfolders: "No subfolders in this location.",
    emptyFolder: "No matches or this folder is empty.",
    loading: "Loading...",
    failedLoad: "Failed to load: ",
    createFolderTitle: "New folder",
    createFolderHint: "Create a new folder inside the current location.",
    folderNamePlaceholder: "Folder name",
    cancel: "Cancel",
    create: "Create",
    folderNameRequired: "Folder name is required.",
    folderCreated: "Folder created.",
    moveTitle: "Move selected items",
    moveHint: "Choose a target folder.",
    moveDone: "Move complete.",
    currentSelection: "Current: {count} items",
    searchPlaceholder: "Search whole tree (name / path / notes)",
    search: "Search",
    renameTitle: "Rename",
    renameHint: "Enter the new name.",
    renameDone: "Rename complete.",
    renameRequired: "New name is required.",
    noteTitle: "Edit notes",
    noteHint: "Add description, tags, usage notes, etc. Notes are also searchable.",
    noteSaved: "Note saved.",
    save: "Save",
    loginTitle: "Enter page password",
    loginHint: "This password only unlocks the page on this browser.",
    loginFail: "Wrong password",
    loginBtn: "Unlock"
  }
};

const state = {
  mode: "private",
  folder: "",
  selectedFiles: [],
  lastLink: "",
  lang: "zh",
  selectedKeys: new Set(),
  currentFolders: [],
  currentFiles: [],
  searchQuery: "",
  renameKey: "",
  noteShortKey: "",
  dragKeys: [],
  dragTargetFolder: ""
};

const el = {
  appRoot: document.getElementById("appRoot"),
  loginOverlay: document.getElementById("loginOverlay"),
  loginTitle: document.getElementById("loginTitle"),
  loginHint: document.getElementById("loginHint"),
  loginInput: document.getElementById("loginInput"),
  loginBtn: document.getElementById("loginBtn"),

  title: document.getElementById("title"),
  subtitle: document.getElementById("subtitle"),
  workspaceLabel: document.getElementById("workspaceLabel"),
  modePrivate: document.getElementById("modePrivate"),
  modePublic: document.getElementById("modePublic"),
  newFolderBtn: document.getElementById("newFolderBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  sideNote: document.getElementById("sideNote"),
  currentModeLabel: document.getElementById("currentModeLabel"),
  uploadBtn: document.getElementById("uploadBtn"),
  bulkWrap: document.getElementById("bulkWrap"),
  bulkSelectedText: document.getElementById("bulkSelectedText"),
  selectAllBtn: document.getElementById("selectAllBtn"),
  moveBtn: document.getElementById("moveBtn"),
  deleteSelectedBtn: document.getElementById("deleteSelectedBtn"),
  breadcrumbs: document.getElementById("breadcrumbs"),
  drop: document.getElementById("drop"),
  dropTitle: document.getElementById("dropTitle"),
  dropSubtitle: document.getElementById("dropSubtitle"),
  fileInput: document.getElementById("fileInput"),
  folderInput: document.getElementById("folderInput"),
  chooseFilesText: document.getElementById("chooseFilesText"),
  chooseFolderText: document.getElementById("chooseFolderText"),
  selected: document.getElementById("selected"),
  status: document.getElementById("status"),
  progressWrap: document.getElementById("progressWrap"),
  progressFill: document.getElementById("progressFill"),
  progressText: document.getElementById("progressText"),
  shareLink: document.getElementById("shareLink"),
  copyLinkBtn: document.getElementById("copyLinkBtn"),
  copyFolderShareBtn: document.getElementById("copyFolderShareBtn"),
  clearSearchBtn: document.getElementById("clearSearchBtn"),
  foldersHead: document.getElementById("foldersHead"),
  filesHead: document.getElementById("filesHead"),
  thName: document.getElementById("thName"),
  thSize: document.getElementById("thSize"),
  thUploaded: document.getElementById("thUploaded"),
  thLink: document.getElementById("thLink"),
  thActions: document.getElementById("thActions"),
  foldersGrid: document.getElementById("foldersGrid"),
  tableBody: document.getElementById("tableBody"),
  folderDialog: document.getElementById("folderDialog"),
  folderNameInput: document.getElementById("folderNameInput"),
  createFolderConfirm: document.getElementById("createFolderConfirm"),
  cancelFolderBtn: document.getElementById("cancelFolderBtn"),
  newFolderTitle: document.getElementById("newFolderTitle"),
  newFolderHint: document.getElementById("newFolderHint"),
  langZh: document.getElementById("langZh"),
  langEn: document.getElementById("langEn"),
  moveDialog: document.getElementById("moveDialog"),
  moveTitle: document.getElementById("moveTitle"),
  moveHint: document.getElementById("moveHint"),
  targetFolderSelect: document.getElementById("targetFolderSelect"),
  confirmMoveBtn: document.getElementById("confirmMoveBtn"),
  cancelMoveBtn: document.getElementById("cancelMoveBtn"),
  masterCheckbox: document.getElementById("masterCheckbox"),
  searchInput: document.getElementById("searchInput"),
  searchBtn: document.getElementById("searchBtn"),
  renameDialog: document.getElementById("renameDialog"),
  renameTitle: document.getElementById("renameTitle"),
  renameHint: document.getElementById("renameHint"),
  renameInput: document.getElementById("renameInput"),
  confirmRenameBtn: document.getElementById("confirmRenameBtn"),
  cancelRenameBtn: document.getElementById("cancelRenameBtn"),
  noteDialog: document.getElementById("noteDialog"),
  noteTitle: document.getElementById("noteTitle"),
  noteHint: document.getElementById("noteHint"),
  noteTextarea: document.getElementById("noteTextarea"),
  saveNoteBtn: document.getElementById("saveNoteBtn"),
  cancelNoteBtn: document.getElementById("cancelNoteBtn"),
  qrDialog: document.getElementById("qrDialog"),
  qrImage: document.getElementById("qrImage"),
  qrLinkInput: document.getElementById("qrLinkInput"),
  viewerBackdrop: document.getElementById("viewerBackdrop"),
  viewerContent: document.getElementById("viewerContent"),
  viewerClose: document.getElementById("viewerClose"),
  floatingPreview: document.getElementById("floatingPreview"),
  floatingPreviewInner: document.getElementById("floatingPreviewInner")
};

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function t(key, vars = {}) {
  let s = (I18N[state.lang] && I18N[state.lang][key]) || key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll("{" + k + "}", v);
  return s;
}

function unlockApp() {
  el.loginOverlay.style.display = "none";
  el.appRoot.style.filter = "none";
  el.appRoot.style.pointerEvents = "auto";
}

function initLock() {
  const ok = localStorage.getItem(APP_LOCK_KEY) === "1";
  if (ok) {
    unlockApp();
  } else {
    el.loginOverlay.style.display = "flex";
    el.appRoot.style.filter = "blur(2px)";
    el.appRoot.style.pointerEvents = "none";
  }
}

function currentFolderShareUrl() {
  const path = state.folder || "";
  return state.mode === "private"
    ? location.origin + "/sf/private/" + encodeURIComponent(path)
    : location.origin + "/sf/public/" + encodeURIComponent(path);
}

function setProgress(percent, text) {
  const p = Math.max(0, Math.min(100, percent || 0));
  el.progressWrap.classList.add("show");
  el.progressFill.style.width = p + "%";
  el.progressText.textContent = text || (Math.round(p) + "%");
}

function resetProgress() {
  el.progressFill.style.width = "0%";
  el.progressText.textContent = "0%";
  el.progressWrap.classList.remove("show");
}

function showViewer(kind, url) {
  if (kind === "image") {
    el.viewerContent.innerHTML = '<img src="' + escapeHtml(url) + '" alt="">';
  } else if (kind === "video") {
    el.viewerContent.innerHTML = '<video src="' + escapeHtml(url) + '" controls autoplay playsinline style="background:#000"></video>';
  } else {
    el.viewerContent.innerHTML = '<iframe src="' + escapeHtml(url) + '" style="width:min(92vw,1000px);height:80vh;border:0;border-radius:12px;background:#fff"></iframe>';
  }
  el.viewerBackdrop.classList.add("show");
}

function hideViewer() {
  el.viewerBackdrop.classList.remove("show");
  el.viewerContent.innerHTML = "";
}

function openQr(link) {
  if (!link) return;
  const qrSrc = "https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=" + encodeURIComponent(link);
  el.qrImage.src = qrSrc;
  el.qrLinkInput.value = link;
  el.qrDialog.showModal();
}

function showFloatingPreview(kind, url) {
  if (!el.floatingPreview || !el.floatingPreviewInner) return;

  if (kind === "image") {
    el.floatingPreviewInner.innerHTML = '<img src="' + escapeHtml(url) + '" alt="">';
  } else if (kind === "video") {
    el.floatingPreviewInner.innerHTML = '<video src="' + escapeHtml(url) + '" muted autoplay loop playsinline></video>';
  } else {
    el.floatingPreviewInner.innerHTML = "";
  }

  el.floatingPreview.style.display = "block";
}

function moveFloatingPreview(e) {
  if (!el.floatingPreview || el.floatingPreview.style.display !== "block") return;

  const gap = 18;
  const boxW = el.floatingPreview.offsetWidth || 300;
  const boxH = el.floatingPreview.offsetHeight || 560;

  let left = e.clientX + gap;
  let top = e.clientY - 40;

  if (left + boxW > window.innerWidth - 12) {
    left = e.clientX - boxW - gap;
  }
  if (top + boxH > window.innerHeight - 12) {
    top = window.innerHeight - boxH - 12;
  }
  if (top < 12) top = 12;
  if (left < 12) left = 12;

  el.floatingPreview.style.left = left + "px";
  el.floatingPreview.style.top = top + "px";
}

function hideFloatingPreview() {
  if (!el.floatingPreview) return;
  el.floatingPreview.style.display = "none";
  el.floatingPreviewInner.innerHTML = "";
}

function applyLanguage() {
  el.title.textContent = t("title");
  el.subtitle.textContent = t("subtitle");
  el.workspaceLabel.textContent = t("workspace");
  el.modePrivate.textContent = t("privateFiles");
  el.modePublic.textContent = t("publicFiles");
  el.newFolderBtn.textContent = t("newFolder");
  el.refreshBtn.textContent = t("refresh");
  el.sideNote.textContent = t("sideNote");
  el.currentModeLabel.textContent = state.mode === "private" ? t("privateMode") : t("publicMode");
  el.uploadBtn.textContent = t("uploadSelected");
  el.selectAllBtn.textContent = t("selectAll");
  el.moveBtn.textContent = t("move");
  el.deleteSelectedBtn.textContent = t("deleteSelected");
  el.dropTitle.textContent = t("dropTitle");
  el.dropSubtitle.textContent = t("dropSubtitle");
  el.chooseFilesText.textContent = t("chooseFiles");
  el.chooseFolderText.textContent = t("chooseFolder");
  el.copyLinkBtn.textContent = t("copyLink");
  el.copyFolderShareBtn.textContent = t("copyFolderShare");
  el.clearSearchBtn.textContent = t("clearSearch");
  el.foldersHead.textContent = t("folders");
  el.filesHead.textContent = t("files");
  el.thName.textContent = t("name");
  el.thSize.textContent = t("size");
  el.thUploaded.textContent = t("uploaded");
  el.thLink.textContent = t("link");
  el.thActions.textContent = t("actions");
  el.newFolderTitle.textContent = t("createFolderTitle");
  el.newFolderHint.textContent = t("createFolderHint");
  el.folderNameInput.placeholder = t("folderNamePlaceholder");
  el.cancelFolderBtn.textContent = t("cancel");
  el.createFolderConfirm.textContent = t("create");
  el.moveTitle.textContent = t("moveTitle");
  el.moveHint.textContent = t("moveHint");
  el.cancelMoveBtn.textContent = t("cancel");
  el.confirmMoveBtn.textContent = t("move");
  el.searchInput.placeholder = t("searchPlaceholder");
  el.searchBtn.textContent = t("search");
  el.renameTitle.textContent = t("renameTitle");
  el.renameHint.textContent = t("renameHint");
  el.cancelRenameBtn.textContent = t("cancel");
  el.confirmRenameBtn.textContent = t("rename");
  el.noteTitle.textContent = t("noteTitle");
  el.noteHint.textContent = t("noteHint");
  el.cancelNoteBtn.textContent = t("cancel");
  el.saveNoteBtn.textContent = t("save");
  el.loginTitle.textContent = t("loginTitle");
  el.loginHint.textContent = t("loginHint");
  el.loginBtn.textContent = t("loginBtn");
  el.langZh.classList.toggle("active", state.lang === "zh");
  el.langEn.classList.toggle("active", state.lang === "en");
  updateBulkBar();
  if (!state.selectedFiles.length) el.selected.textContent = t("noFilesSelected");
}

function setStatus(msg) { el.status.textContent = msg; }

function setMode(mode) {
  state.mode = mode === "public" ? "public" : "private";
  el.modePrivate.classList.toggle("active", state.mode === "private");
  el.modePublic.classList.toggle("active", state.mode === "public");
  el.currentModeLabel.textContent = state.mode === "private" ? t("privateMode") : t("publicMode");
  state.folder = "";
  state.searchQuery = "";
  el.searchInput.value = "";
  state.selectedKeys.clear();
  state.dragKeys = [];
  state.dragTargetFolder = "";
  loadList();
}

function setLang(lang) {
  state.lang = lang === "en" ? "en" : "zh";
  applyLanguage();
  loadList();
}

function setSelectedFiles(files) {
  state.selectedFiles = files || [];
  if (!state.selectedFiles.length) {
    el.selected.textContent = t("noFilesSelected");
    setStatus(t("waiting"));
    return;
  }
  if (state.selectedFiles.length === 1) {
    el.selected.textContent = state.selectedFiles[0].file.name;
    setStatus(t("selectedOne"));
  } else {
    el.selected.textContent = t("selectedMany", { count: state.selectedFiles.length });
    setStatus(t("selectedMany", { count: state.selectedFiles.length }));
  }
}

function fileToSelection(file, relPath) {
  return { file, relPath: relPath || "" };
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return "-";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
}

function formatDate(v) {
  if (!v) return "-";
  try { return new Date(v).toLocaleString(); } catch { return v; }
}

async function copyText(text) {
  if (!text) {
    setStatus(t("copyFailed"));
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setStatus(t("linkCopied"));
  } catch {
    setStatus(t("copyFailed"));
  }
}

function renderBreadcrumbs(items) {
  el.breadcrumbs.innerHTML = "";
  const normalized = (items || []).map(function(item, idx) {
    return {
      name: idx === 0 ? t("root") : (item.name || item.relFolder || item.folder || ""),
      folder: item.folder || ""
    };
  });

  normalized.forEach(function(crumb, idx) {
    const btn = document.createElement("button");
    btn.className = "crumb" + (idx === normalized.length - 1 ? " current" : "");
    btn.textContent = crumb.name;
    btn.type = "button";
    if (idx !== normalized.length - 1) {
      btn.onclick = function() {
        state.folder = crumb.folder;
        state.selectedKeys.clear();
        state.dragKeys = [];
        state.dragTargetFolder = "";
        loadList();
      };
    } else {
      btn.disabled = true;
    }
    el.breadcrumbs.appendChild(btn);

    if (idx !== normalized.length - 1) {
      const sep = document.createElement("span");
      sep.textContent = "/";
      sep.style.color = "#98A2B3";
      el.breadcrumbs.appendChild(sep);
    }
  });
}

async function moveSelectedToFolder(targetFolder) {
  const selected = Array.from(state.selectedKeys);
  if (!selected.length) {
    setStatus(t("noSelection"));
    return;
  }

  const movableKeys = [];

  for (const key of selected) {
    if (!key.startsWith(state.mode + "/")) continue;

    if (key.endsWith("/.folder")) {
      const srcFolder = key.replace(new RegExp("^" + state.mode + "/"), "").replace(/\/\.folder$/, "");

      if (targetFolder === srcFolder) {
        continue;
      }

      if (targetFolder.startsWith(srcFolder + "/")) {
        setStatus("Cannot move a folder into itself or its child folder.");
        return;
      }

      movableKeys.push(key);
    } else {
      const shortKey = key.replace(new RegExp("^" + state.mode + "/"), "");
      const currentParent = shortKey.split("/").slice(0, -1).join("/");

      if (currentParent === targetFolder) {
        continue;
      }

      movableKeys.push(key);
    }
  }

  if (!movableKeys.length) {
    setStatus("Nothing to move.");
    return;
  }

  try {
    setStatus("Moving...");
    const resp = await fetch("/api/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: state.mode,
        keys: movableKeys,
        targetFolder
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      throw new Error((data.error || "Move failed") + (data.detail ? ": " + data.detail : ""));
    }

    state.selectedKeys.clear();
    state.dragKeys = [];
    state.dragTargetFolder = "";
    setStatus(t("moveDone"));
    await loadList();
  } catch (err) {
    setStatus("Move failed: " + err.message);
  }
}

function renderFolders(folders) {
  state.currentFolders = folders || [];
  if (!folders.length) {
    el.foldersGrid.innerHTML = '<div class="empty">' + escapeHtml(t("noSubfolders")) + '</div>';
    return;
  }

  el.foldersGrid.innerHTML = "";
  folders.forEach(function(folder) {
    const card = document.createElement("div");
    card.className = "folder-card";
    card.draggable = true;

    card.onclick = function(e) {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "button" || tag === "input") return;
      openFolder(folder.folder);
    };

    card.addEventListener("dragstart", function(e) {
      if (!state.selectedKeys.has(folder.key)) {
        e.preventDefault();
        return;
      }
      state.dragKeys = Array.from(state.selectedKeys);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "move");
    });

    card.addEventListener("dragenter", function(e) {
      if (!state.selectedKeys.size) return;
      e.preventDefault();
      state.dragTargetFolder = folder.folder;
      card.classList.add("drop-target");
    });

    card.addEventListener("dragover", function(e) {
      if (!state.selectedKeys.size) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      state.dragTargetFolder = folder.folder;
      card.classList.add("drop-target");
    });

    card.addEventListener("dragleave", function() {
      card.classList.remove("drop-target");
    });

    card.addEventListener("drop", async function(e) {
      e.preventDefault();
      card.classList.remove("drop-target");
      if (!state.selectedKeys.size) return;
      await moveSelectedToFolder(folder.folder);
    });

    card.addEventListener("dragend", function() {
      card.classList.remove("drop-target");
      state.dragTargetFolder = "";
    });

    const top = document.createElement("div");
    top.style.display = "flex";
    top.style.justifyContent = "space-between";
    top.style.gap = "8px";
    top.style.alignItems = "flex-start";

    const icon = document.createElement("div");
    icon.className = "folder-top";
    icon.textContent = "📁";
    icon.style.cursor = "pointer";
    icon.title = t("openFolder");
    icon.onclick = function(e) {
      e.stopPropagation();
      openFolder(folder.folder);
    };

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = state.selectedKeys.has(folder.key);
    chk.onchange = function() { toggleSelection(folder.key, chk.checked); };
    chk.onclick = function(e) { e.stopPropagation(); };

    top.appendChild(icon);
    top.appendChild(chk);

    const name = document.createElement("div");
    name.className = "folder-name";
    name.textContent = folder.name;

    const sub = document.createElement("div");
    sub.className = "folder-sub";
    sub.textContent = t("openFolder");

    const actionWrap = document.createElement("div");
    actionWrap.style.marginTop = "12px";
    actionWrap.className = "actions";

    const openBtn = document.createElement("button");
    openBtn.className = "mini";
    openBtn.textContent = t("open");
    openBtn.onclick = function(e) { e.stopPropagation(); openFolder(folder.folder); };

    const shareBtn = document.createElement("button");
    shareBtn.className = "mini";
    shareBtn.textContent = t("shareFolder");
    shareBtn.onclick = function(e) { e.stopPropagation(); copyText(folder.shareUrl); };

    const qrBtn = document.createElement("button");
    qrBtn.className = "mini";
    qrBtn.textContent = t("qr");
    qrBtn.onclick = function(e) { e.stopPropagation(); openQr(folder.shareUrl); };

    const renameBtn = document.createElement("button");
    renameBtn.className = "mini";
    renameBtn.textContent = t("rename");
    renameBtn.onclick = function(e) { e.stopPropagation(); openRenameDialog(folder.key, folder.name); };

    actionWrap.appendChild(openBtn);
    actionWrap.appendChild(shareBtn);
    actionWrap.appendChild(qrBtn);
    actionWrap.appendChild(renameBtn);

    card.appendChild(top);
    card.appendChild(name);
    card.appendChild(sub);
    card.appendChild(actionWrap);
    el.foldersGrid.appendChild(card);
  });
}

async function openNoteDialog(shortKey) {
  state.noteShortKey = shortKey;
  try {
    const resp = await fetch("/api/note/get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: state.mode, shortKey })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Failed to load note");
    el.noteTextarea.value = data.note || "";
    el.noteDialog.showModal();
  } catch (err) {
    setStatus("Note load failed: " + err.message);
  }
}

async function saveNote() {
  try {
    const resp = await fetch("/api/note/set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: state.mode,
        shortKey: state.noteShortKey,
        note: el.noteTextarea.value || ""
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Save note failed");
    el.noteDialog.close();
    setStatus(t("noteSaved"));
    await loadList();
  } catch (err) {
    setStatus("Save note failed: " + err.message);
  }
}

function updateBulkBar() {
  const count = state.selectedKeys.size;
  el.bulkSelectedText.textContent = t("currentSelection", { count: count });
  el.bulkWrap.classList.toggle("show", count > 0);
  const total = state.currentFolders.length + state.currentFiles.length;
  el.masterCheckbox.checked = count > 0 && count === total;
}

async function loadList() {
  el.tableBody.innerHTML = '<tr><td colspan="6" class="empty">' + escapeHtml(t("loading")) + '</td></tr>';
  try {
    const qs = new URLSearchParams({
      mode: state.mode,
      folder: state.folder,
      q: state.searchQuery
    });
    const resp = await fetch("/api/list?" + qs.toString());
    const data = await resp.json();

    if (!resp.ok) throw new Error(data.error || "Failed to load");

    renderBreadcrumbs(data.breadcrumbs || [{ name: t("root"), folder: "" }]);
    renderFolders(data.folders || []);

    const files = data.files || [];
    state.currentFiles = files;

    if (!files.length) {
      el.tableBody.innerHTML = '<tr><td colspan="6" class="empty">' + escapeHtml(t("emptyFolder")) + '</td></tr>';
      updateBulkBar();
      return;
    }

    el.tableBody.innerHTML = "";

    files.forEach(function(file) {
      const tr = document.createElement("tr");
      tr.draggable = true;

      tr.addEventListener("dragstart", function(e) {
        if (!state.selectedKeys.has(file.key)) {
          e.preventDefault();
          return;
        }
        state.dragKeys = Array.from(state.selectedKeys);
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "move");
      });

      const lower = file.name.toLowerCase();
      const isImage = /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(lower);
      const isVideo = /\.(mp4|webm|ogg|mov|m4v)$/i.test(lower);

      const tdChk = document.createElement("td");
      tdChk.className = "chk";
      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = state.selectedKeys.has(file.key);
      chk.onchange = function() { toggleSelection(file.key, chk.checked); };
      tdChk.appendChild(chk);

      const tdName = document.createElement("td");
      const nameCell = document.createElement("div");
      nameCell.className = "name-cell";

      if (isImage) {
        const icon = document.createElement("div");
        icon.className = "icon image";

        const img = document.createElement("img");
        img.className = "thumb";
        img.src = file.url;
        icon.appendChild(img);

        icon.addEventListener("mouseenter", function() {
          showFloatingPreview("image", file.url);
        });
        icon.addEventListener("mousemove", function(e) {
          moveFloatingPreview(e);
        });
        icon.addEventListener("mouseleave", function() {
          hideFloatingPreview();
        });

        nameCell.appendChild(icon);
      } else if (isVideo) {
        const icon = document.createElement("div");
        icon.className = "icon video";
        icon.textContent = "🎬";

        icon.addEventListener("mouseenter", function() {
          showFloatingPreview("video", file.url);
        });
        icon.addEventListener("mousemove", function(e) {
          moveFloatingPreview(e);
        });
        icon.addEventListener("mouseleave", function() {
          hideFloatingPreview();
        });

        nameCell.appendChild(icon);
      } else {
        const icon = document.createElement("div");
        icon.className = "icon";
        icon.textContent = lower.match(/\.pdf$/) ? "📄" : "📦";
        nameCell.appendChild(icon);
      }

      const textWrap = document.createElement("div");
      const title = document.createElement("div");
      title.textContent = file.name;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = file.mode + " · " + file.shortKey;
      textWrap.appendChild(title);
      textWrap.appendChild(meta);

      if (file.note) {
        const notePreview = document.createElement("div");
        notePreview.className = "note-preview";
        notePreview.textContent = file.note;
        textWrap.appendChild(notePreview);
      }

      nameCell.appendChild(textWrap);
      tdName.appendChild(nameCell);

      const tdSize = document.createElement("td");
      tdSize.textContent = formatSize(file.size);

      const tdUploaded = document.createElement("td");
      tdUploaded.textContent = formatDate(file.uploaded);

      const tdLink = document.createElement("td");
      tdLink.className = "link-cell";
      const a = document.createElement("a");
      a.href = file.url;
      a.target = "_blank";
      a.textContent = file.url;
      tdLink.appendChild(a);

      const tdActions = document.createElement("td");
      const actions = document.createElement("div");
      actions.className = "actions";

      const btnCopy = document.createElement("button");
      btnCopy.className = "mini";
      btnCopy.textContent = t("copy");
      btnCopy.onclick = function() { copyText(file.url); };

      const btnOpen = document.createElement("button");
      btnOpen.className = "mini";
      btnOpen.textContent = t("open");
      btnOpen.onclick = function() { window.open(file.url, "_blank"); };

      const btnPreview = document.createElement("button");
      btnPreview.className = "mini";
      btnPreview.textContent = isVideo ? t("play") : t("preview");
      btnPreview.onclick = function() {
        if (isImage) showViewer("image", file.url);
        else if (isVideo) showViewer("video", file.url);
        else showViewer("iframe", file.url);
      };

      const btnQr = document.createElement("button");
      btnQr.className = "mini";
      btnQr.textContent = t("qr");
      btnQr.onclick = function() { openQr(file.url); };

      const btnNote = document.createElement("button");
      btnNote.className = "mini";
      btnNote.textContent = t("notes");
      btnNote.onclick = function() { openNoteDialog(file.shortKey); };

      const btnRename = document.createElement("button");
      btnRename.className = "mini";
      btnRename.textContent = t("rename");
      btnRename.onclick = function() { openRenameDialog(file.key, file.name); };

      const btnDelete = document.createElement("button");
      btnDelete.className = "mini danger";
      btnDelete.textContent = t("delete");
      btnDelete.onclick = function() { deleteFile(file.key); };

      actions.appendChild(btnCopy);
      actions.appendChild(btnOpen);
      actions.appendChild(btnPreview);
      actions.appendChild(btnQr);
      actions.appendChild(btnNote);
      actions.appendChild(btnRename);
      actions.appendChild(btnDelete);
      tdActions.appendChild(actions);

      tr.appendChild(tdChk);
      tr.appendChild(tdName);
      tr.appendChild(tdSize);
      tr.appendChild(tdUploaded);
      tr.appendChild(tdLink);
      tr.appendChild(tdActions);
      el.tableBody.appendChild(tr);
    });

    updateBulkBar();
  } catch (err) {
    el.tableBody.innerHTML = '<tr><td colspan="6" class="empty">' + escapeHtml(t("failedLoad") + err.message) + '</td></tr>';
    updateBulkBar();
  }
}

async function uploadSelected() {
  if (!state.selectedFiles.length) {
    setStatus(t("pleaseChoose"));
    return;
  }

  el.uploadBtn.disabled = true;
  el.shareLink.value = "";
  state.lastLink = "";

  try {
    setStatus(t("uploading", { count: state.selectedFiles.length }));

    const totalCount = state.selectedFiles.length;
    let done = 0;

    for (const entry of state.selectedFiles) {
      const form = new FormData();
      form.append("mode", state.mode);
      form.append("folder", state.folder);
      form.append("files", entry.file);
      if (entry.relPath) {
        form.append("relpath:" + entry.file.name, entry.relPath);
      }

      const resp = await fetch("/api/upload", {
        method: "POST",
        body: form
      });

      const data = await resp.json().catch(function() { return {}; });
      if (!resp.ok) {
        setStatus((data.error || "Upload failed") + (data.detail ? ": " + data.detail : ""));
        break;
      }

      if (!state.lastLink && data.firstUrl) {
        state.lastLink = data.firstUrl;
        el.shareLink.value = state.lastLink;
      }

      done += 1;
      const p = (done / totalCount) * 100;
      setProgress(p, done + " / " + totalCount + " · " + Math.round(p) + "%");
    }

    if (done === totalCount) {
      setStatus(t("uploadComplete", { count: totalCount }));
      try {
        if (state.lastLink) {
          await navigator.clipboard.writeText(state.lastLink);
          setStatus(t("uploadCompleteCopied", { count: totalCount }));
        }
      } catch {}
    }

    setSelectedFiles([]);
    el.fileInput.value = "";
    el.folderInput.value = "";
    await loadList();
  } catch (err) {
    setStatus("Upload failed: " + err.message);
  } finally {
    el.uploadBtn.disabled = false;
    setTimeout(resetProgress, 1200);
  }
}

async function deleteFile(key) {
  if (!confirm(t("deleteConfirm"))) return;
  try {
    const resp = await fetch("/api/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: key })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error((data.error || "Delete failed") + (data.detail ? ": " + data.detail : ""));
    state.selectedKeys.delete(key);
    setStatus(t("deleted"));
    await loadList();
  } catch (err) {
    setStatus("Delete failed: " + err.message);
  }
}

function openFolder(folder) {
  state.folder = folder || "";
  state.selectedKeys.clear();
  state.dragKeys = [];
  state.dragTargetFolder = "";
  hideFloatingPreview();
  loadList();
}

async function createFolder() {
  const name = el.folderNameInput.value.trim();
  if (!name) {
    setStatus(t("folderNameRequired"));
    return;
  }

  try {
    const resp = await fetch("/api/create-folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: state.mode,
        folder: state.folder,
        name: name
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error((data.error || "Create folder failed") + (data.detail ? ": " + data.detail : ""));
    el.folderDialog.close();
    el.folderNameInput.value = "";
    setStatus(t("folderCreated"));
    await loadList();
  } catch (err) {
    setStatus("Create folder failed: " + err.message);
  }
}

function toggleSelection(key, checked) {
  if (checked) state.selectedKeys.add(key);
  else state.selectedKeys.delete(key);
  updateBulkBar();
}

function toggleSelectAll() {
  const total = state.currentFolders.concat(state.currentFiles);
  const shouldSelect = state.selectedKeys.size !== total.length;
  state.selectedKeys.clear();
  if (shouldSelect) total.forEach(function(item) { state.selectedKeys.add(item.key); });
  loadList();
}

async function deleteSelected() {
  if (!state.selectedKeys.size) {
    setStatus(t("noSelection"));
    return;
  }
  if (!confirm(t("deleteConfirm"))) return;

  try {
    const resp = await fetch("/api/delete-many", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys: Array.from(state.selectedKeys) })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error((data.error || "Bulk delete failed") + (data.detail ? ": " + data.detail : ""));
    state.selectedKeys.clear();
    state.dragKeys = [];
    state.dragTargetFolder = "";
    setStatus(t("deleted"));
    await loadList();
  } catch (err) {
    setStatus("Delete failed: " + err.message);
  }
}

async function openMoveDialog() {
  if (!state.selectedKeys.size) {
    setStatus(t("noSelection"));
    return;
  }

  try {
    const resp = await fetch("/api/list-folders?mode=" + encodeURIComponent(state.mode));
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Failed to load folders");

    el.targetFolderSelect.innerHTML = "";
    const folders = data.folders || [""];
    folders.forEach(function(folder) {
      const opt = document.createElement("option");
      opt.value = folder;
      opt.textContent = folder || t("root");
      el.targetFolderSelect.appendChild(opt);
    });

    el.moveDialog.showModal();
  } catch (err) {
    setStatus("Move failed: " + err.message);
  }
}

async function confirmMove() {
  if (!state.selectedKeys.size) {
    setStatus(t("noSelection"));
    return;
  }

  try {
    const resp = await fetch("/api/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: state.mode,
        keys: Array.from(state.selectedKeys),
        targetFolder: el.targetFolderSelect.value
      })
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error((data.error || "Move failed") + (data.detail ? ": " + data.detail : ""));

    el.moveDialog.close();
    state.selectedKeys.clear();
    state.dragKeys = [];
    state.dragTargetFolder = "";
    setStatus(t("moveDone"));
    await loadList();
  } catch (err) {
    setStatus("Move failed: " + err.message);
  }
}

function openRenameDialog(key, currentName) {
  state.renameKey = key;
  el.renameInput.value = currentName || "";
  el.renameDialog.showModal();
}

async function confirmRename() {
  const newName = el.renameInput.value.trim();
  if (!newName) {
    setStatus(t("renameRequired"));
    return;
  }

  try {
    const resp = await fetch("/api/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: state.mode,
        key: state.renameKey,
        newName: newName
      })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error((data.error || "Rename failed") + (data.detail ? ": " + data.detail : ""));
    el.renameDialog.close();
    state.renameKey = "";
    setStatus(t("renameDone"));
    await loadList();
  } catch (err) {
    setStatus("Rename failed: " + err.message);
  }
}

function handleSearch() {
  state.searchQuery = (el.searchInput.value || "").trim();
  state.dragKeys = [];
  state.dragTargetFolder = "";
  hideFloatingPreview();
  loadList();
}

async function getDroppedFilesFromItems(items) {
  const out = [];
  const itemArray = Array.from(items || []);

  async function readEntry(entry, pathPrefix) {
    if (!entry) return;

    if (entry.isFile) {
      await new Promise((resolve) => {
        entry.file((file) => {
          const relPath = pathPrefix ? pathPrefix + "/" + file.name : file.name;
          out.push(fileToSelection(file, relPath));
          resolve();
        }, () => resolve());
      });
      return;
    }

    if (entry.isDirectory) {
      const reader = entry.createReader();
      const entries = await readAllDirectoryEntries(reader);
      for (const child of entries) {
        await readEntry(child, pathPrefix ? pathPrefix + "/" + entry.name : entry.name);
      }
    }
  }

  for (const item of itemArray) {
    let entry = null;
    if (typeof item.getAsEntry === "function") entry = item.getAsEntry();
    else if (typeof item.webkitGetAsEntry === "function") entry = item.webkitGetAsEntry();

    if (entry) await readEntry(entry, "");
    else {
      const file = item.getAsFile ? item.getAsFile() : null;
      if (file) out.push(fileToSelection(file, file.name));
    }
  }
  return out;
}

async function readAllDirectoryEntries(reader) {
  const entries = [];
  while (true) {
    const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (!batch.length) break;
    entries.push(...batch);
  }
  return entries;
}

el.modePrivate.onclick = function() { setMode("private"); };
el.modePublic.onclick = function() { setMode("public"); };
el.newFolderBtn.onclick = function() { el.folderDialog.showModal(); };
el.refreshBtn.onclick = function() { hideFloatingPreview(); state.dragKeys = []; state.dragTargetFolder = ""; loadList(); };
el.uploadBtn.onclick = uploadSelected;
el.copyLinkBtn.onclick = function() { copyText(el.shareLink.value); };
el.copyFolderShareBtn.onclick = function() { copyText(currentFolderShareUrl()); openQr(currentFolderShareUrl()); };
el.clearSearchBtn.onclick = function() {
  state.searchQuery = "";
  el.searchInput.value = "";
  state.dragKeys = [];
  state.dragTargetFolder = "";
  hideFloatingPreview();
  loadList();
};
el.createFolderConfirm.onclick = createFolder;
el.langZh.onclick = function() { setLang("zh"); };
el.langEn.onclick = function() { setLang("en"); };
el.selectAllBtn.onclick = toggleSelectAll;
el.moveBtn.onclick = openMoveDialog;
el.confirmMoveBtn.onclick = confirmMove;
el.deleteSelectedBtn.onclick = deleteSelected;
el.masterCheckbox.onchange = toggleSelectAll;
el.searchBtn.onclick = handleSearch;
el.searchInput.addEventListener("keydown", function(e) { if (e.key === "Enter") handleSearch(); });
el.confirmRenameBtn.onclick = confirmRename;
el.saveNoteBtn.onclick = saveNote;
el.viewerClose.onclick = hideViewer;
el.viewerBackdrop.onclick = function(e) { if (e.target === el.viewerBackdrop) hideViewer(); };
el.loginBtn.onclick = function() {
  if (el.loginInput.value === APP_UNLOCK_PASSWORD) {
    localStorage.setItem(APP_LOCK_KEY, "1");
    unlockApp();
  } else {
    setStatus(t("loginFail"));
  }
};

el.fileInput.addEventListener("change", function() {
  const files = Array.from(el.fileInput.files || []).map(function(file) {
    return fileToSelection(file, "");
  });
  setSelectedFiles(files);
});

el.folderInput.addEventListener("change", function() {
  const files = Array.from(el.folderInput.files || []).map(function(file) {
    return fileToSelection(file, file.webkitRelativePath || file.name);
  });
  setSelectedFiles(files);
});

["dragenter", "dragover"].forEach(function(evt) {
  el.drop.addEventListener(evt, function(e) {
    e.preventDefault();
    el.drop.classList.add("drag");
  });
});

["dragleave", "drop"].forEach(function(evt) {
  el.drop.addEventListener(evt, function(e) {
    e.preventDefault();
    el.drop.classList.remove("drag");
  });
});

el.drop.addEventListener("drop", async function(e) {
  e.preventDefault();
  el.drop.classList.remove("drag");

  const items = e.dataTransfer && e.dataTransfer.items ? e.dataTransfer.items : null;
  let files = [];

  if (items && items.length) {
    try { files = await getDroppedFilesFromItems(items); } catch { files = []; }
  }

  if (!files.length) {
    files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).map(function(file) {
      return fileToSelection(file, file.name);
    });
  }

  if (!files.length) return;
  setSelectedFiles(files);
  await uploadSelected();
});

applyLanguage();
initLock();
setStatus(t("waiting"));
loadList();
</script>
</body>
</html>`;
}
