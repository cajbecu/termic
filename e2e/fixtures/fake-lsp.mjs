#!/usr/bin/env node
// A language server that exists to prove the host, not to understand code
// (GH #174). It speaks real LSP over stdio with real `Content-Length` framing,
// and it is deliberately as demanding as the servers that bit us:
//
//  - It refuses to do anything until the client answers a
//    `workspace/configuration` request with an array of the right LENGTH.
//    ty panics and exits when that length is wrong, and hangs forever when the
//    reply never comes; @codemirror/lsp-client answers every server request
//    with -32601, so this passing at all is the proof our Rust host intercepts
//    them.
//  - It requires `workspaceFolders` in `initialize`, which the CM client does
//    not send (only `rootUri`). ruby-lsp and clangd each read one of the two.
//  - It writes what it saw to `.fake-lsp.json` IN ITS CWD, so the spec can
//    assert the child was spawned at the checkout rather than wherever termic
//    was launched from. A wrong cwd is what makes ty index a user's whole home
//    directory.
//
// It reports one diagnostic per opened document, which is the observable end
// of the pipe: DOM in the editor, produced by bytes that went through the
// framer, the interception and the sync.

import { writeFileSync } from "node:fs";

const seen = { initialize: null, configReply: null, opened: [] };
const record = () => {
  try { writeFileSync(".fake-lsp.json", JSON.stringify(seen, null, 2)); } catch { /* not fatal */ }
};

const send = (msg) => {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};

let nextId = 1000;
/** Documents waiting for the configuration answer before they get diagnostics. */
const pending = [];
let configured = false;

function publish(uri) {
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri,
      diagnostics: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        severity: 1,
        source: "fake-lsp",
        message: "fake-lsp saw this file",
      }],
    },
  });
}

function handle(msg) {
  if (msg.method === "initialize") {
    seen.initialize = msg.params;
    record();
    // A server that is handed no workspace folders answers with nothing,
    // which is how this fails loudly rather than silently passing.
    const folders = msg.params?.workspaceFolders;
    if (!Array.isArray(folders) || folders.length === 0) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "no workspaceFolders" } });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          hoverProvider: true,
          definitionProvider: true,
          completionProvider: { triggerCharacters: ["."] },
          referencesProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
        },
        serverInfo: { name: "fake-lsp", version: "1" },
      },
    });
    return;
  }
  if (msg.method === "initialized") {
    // Ask for two configuration sections. The reply must be an array of two.
    send({
      jsonrpc: "2.0",
      id: nextId++,
      method: "workspace/configuration",
      params: { items: [{ section: "fake" }, { section: "fake.other" }] },
    });
    return;
  }
  if (msg.method === "textDocument/didOpen") {
    const uri = msg.params?.textDocument?.uri;
    seen.opened.push({ uri, languageId: msg.params?.textDocument?.languageId });
    record();
    if (configured) publish(uri);
    else pending.push(uri);
    return;
  }
  if (msg.method === "textDocument/documentSymbol") {
    // The tree shape (DocumentSymbol), which is what current servers answer
    // with. The flat shape is covered by a unit test.
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [{
        name: "FakeClass", kind: 5,
        range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
        selectionRange: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
        children: [{
          name: "fakeMethod", kind: 6,
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
          selectionRange: { start: { line: 1, character: 4 }, end: { line: 1, character: 14 } },
        }],
      }],
    });
    return;
  }
  if (msg.method === "workspace/symbol") {
    // A symbol whose name appears nowhere in any open buffer, so finding it
    // proves the SERVER answered rather than something scraping the editor.
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [{
        name: "fakeWorkspaceSymbol", kind: 5, containerName: "fixtures",
        location: {
          uri: seen.opened[0]?.uri ?? "",
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        },
      }],
    });
    return;
  }
  if (msg.method === "textDocument/definition") {
    // Line 10 is the LONE symbol: its definition is itself, so a click there
    // takes the "you are already at the definition, show me the callers"
    // branch, and the references reply below answers with none. That pair is
    // what drives the client's empty state.
    if (msg.params?.position?.line === 9) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          uri: msg.params.textDocument.uri,
          range: { start: { line: 9, character: 13 }, end: { line: 9, character: 19 } },
        },
      });
      return;
    }
    // Otherwise the definition always lives on line 1, columns 13-19. A click
    // ON that range is "you are already at the definition"; a click anywhere
    // else is a usage. That split is the whole behaviour under test.
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        uri: msg.params.textDocument.uri,
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
      },
    });
    return;
  }
  if (msg.method === "textDocument/references") {
    // A LONE symbol answers with nothing, so the client's empty state can be
    // driven: "no usages" is a real answer a server gives, and the editor used
    // to render it as silence.
    if (msg.params?.position?.line === 9) {
      send({ jsonrpc: "2.0", id: msg.id, result: [] });
      return;
    }
    // Four locations, three usages: the first is deliberately reported TWICE,
    // which is what a real server does when a reference comes from both the
    // open document and the index, and the popup used to list both. The last
    // sits in a DIFFERENT directory under the same basename, so the row labels
    // have a clash to disambiguate (`lib/lsp/usageLabels.ts`); every other row
    // stays on its bare name.
    const here = msg.params.textDocument.uri;
    const twin = here.replace(/\/([^/]+)$/, "/nested/$1");
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        { uri: here,
          range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } } },
        { uri: here,
          range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } } },
        { uri: here,
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } } },
        { uri: twin,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } } },
      ],
    });
    return;
  }
  if (msg.method === "textDocument/completion") {
    // One item nothing else could invent: the local word-scraper can only
    // offer words already in the buffer, so a completion whose label appears
    // nowhere in the file is proof the SERVER's list reached the editor.
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        isIncomplete: false,
        items: [{ label: "fakeLspOnlySymbol", kind: 6, detail: "from fake-lsp" }],
      },
    });
    return;
  }
  if (msg.method === "textDocument/hover") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { contents: { kind: "markdown", value: "**fake-lsp** knows this symbol" } },
    });
    return;
  }
  if (msg.method === "shutdown") {
    send({ jsonrpc: "2.0", id: msg.id, result: null });
    return;
  }
  if (msg.method === "exit") process.exit(0);
  // A response to one of OUR requests: the configuration answer.
  if (msg.id !== undefined && msg.method === undefined) {
    seen.configReply = msg.result ?? msg.error ?? null;
    record();
    // The length assertion ty makes. Anything else and this server stays
    // silent for the rest of its life, exactly like the real one.
    if (Array.isArray(msg.result) && msg.result.length === 2) {
      configured = true;
      for (const uri of pending.splice(0)) publish(uri);
    }
    return;
  }
  // Any other request must still be answered or the client's own timeouts
  // start firing.
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: null });
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headEnd = buf.indexOf("\r\n\r\n");
    if (headEnd < 0) return;
    const header = buf.subarray(0, headEnd).toString("ascii");
    const m = /content-length:\s*(\d+)/i.exec(header);
    if (!m) { buf = buf.subarray(headEnd + 4); continue; }
    const len = Number(m[1]);
    const start = headEnd + 4;
    // Byte length, like the header says. A character count here is the bug
    // this fixture would hide rather than catch.
    if (buf.length < start + len) return;
    const body = buf.subarray(start, start + len).toString("utf8");
    buf = buf.subarray(start + len);
    try { handle(JSON.parse(body)); } catch { /* ignore junk */ }
  }
});
process.stdin.on("end", () => process.exit(0));
