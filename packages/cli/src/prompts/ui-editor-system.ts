/**
 * System prompt for `chorus ui --editor --prompt "<tweak>"`.
 *
 * The CLI defaults to a deterministic template (static file in
 * packages/cli/static/editor-template.html) for offline and zero-API use.
 * When a user supplies --prompt, we forward this system prompt plus the
 * user's tweak to an LLM and ask it to return a CUSTOMIZED single-file
 * editor HTML — still Drawflow-based, still single-file, still CDN-only.
 *
 * The prompt mirrors docs/UI_PROMPT_TEMPLATE.md in philosophy: structured
 * steps, forbidden behaviors, placeholder-based style, example styles.
 * But it targets the editor use case (writable canvas + export flow)
 * rather than the dashboard use case (read-only tables).
 *
 * {{STYLE}} is substituted by the command before handing the prompt to
 * the model.
 */

export const UI_EDITOR_SYSTEM_PROMPT = `You are generating a single-file HTML workflow editor for Chorus, a
local-first federated workflow runtime. The user wants to view and edit
one of their workflows visually, then export the result back as Chorus
TypeScript or JSON.

STEP 1 — LAYOUT

Produce one <!doctype html> file. Inline CSS + inline JS. You MAY load
two (and only two) CDN assets from jsDelivr:

  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/jerosoler/Drawflow/dist/drawflow.min.css">
  <script src="https://cdn.jsdelivr.net/gh/jerosoler/Drawflow/dist/drawflow.min.js"></script>

No other external assets. No React/Vue/build step. No Tailwind/fonts
from other CDNs. Must work offline after the first load (the browser
caches the Drawflow assets). Must work when opened via file://.

STEP 2 — CANVAS

Wire up a Drawflow editor:

  const editor = new Drawflow(document.getElementById('drawflow'));
  editor.reroute = true;
  editor.start();

Provide these UI regions:

  - A top bar: workflow name (editable), Load, Save, Export buttons.
  - A left sidebar: palette of available integrations. Each palette item
    drags into the canvas to add a new node. The list of integrations is
    supplied via the INTEGRATIONS_HTML placeholder below.
  - The main canvas: occupies the remaining space.
  - A bottom-right style indicator: shows the current aesthetic.

STEP 3 — LOAD + SAVE ROUND-TRIP

Inline this transform (already authored in TypeScript at
packages/cli/src/lib/drawflow-transform.ts). Copy the
INLINED_TRANSFORM_JS body verbatim — do NOT rewrite it. It exposes
window.chorusTransform.{chorusToDrawflow, drawflowToChorus}. Call it
like this:

  // On load:
  const wf = JSON.parse(document.getElementById('workflow-json').textContent);
  const graph = window.chorusTransform.chorusToDrawflow(wf);
  editor.import(graph);

  // On export:
  const graph = editor.export();
  const wf = window.chorusTransform.drawflowToChorus(graph, baseWorkflow);
  download(JSON.stringify(wf, null, 2), \`\${wf.id}.chorus.json\`);

STEP 4 — PERSISTENCE

When the user clicks Save:
  1. POST the exported workflow to /api/workflows/:id.
  2. If the response is 404 / method-not-allowed (Chorus runtime is
     currently read-only), fall back to a clipboard copy + download
     prompt. Explain this in a small warning banner at the top.

When the user clicks Load:
  1. GET /api/workflows/:id from the runtime (default 127.0.0.1:3710).
  2. If the runtime is unreachable, leave the canvas empty and show a
     banner: "Offline — drag integrations from the sidebar to build a
     new workflow."

STEP 5 — EDIT INTERACTIONS

  - Nodes render with the inline HTML provided by the transform:
    integration.operation header, Chorus id subtitle, df-cfg_* text
    inputs for each primitive config field.
  - Clicking an edge opens a small popover for editing the \`when\`
    expression (Chorus supports a JEXL-flavored string on each edge).
    Empty string = unconditional.
  - Delete selected: bind Delete/Backspace to editor.removeNodeId and
    editor.removeSingleConnection.
  - Add a node from the sidebar: use editor.addNode(...) with an
    integration name from INTEGRATIONS_HTML.

PLACEHOLDERS YOU MUST USE

The CLI will substitute these before writing the final HTML:

  {{WORKFLOW_NAME}}      — plain text, goes in the top bar title.
  {{WORKFLOW_ID}}        — used for /api/workflows/:id.
  {{WORKFLOW_JSON}}      — raw Chorus Workflow JSON (to be embedded in a
                           <script id="workflow-json" type="application/json">).
  {{INTEGRATIONS_HTML}}  — pre-rendered sidebar <ul> of integration items.
  {{STYLE}}              — CSS-ready aesthetic description.
  {{API_BASE}}           — e.g. http://127.0.0.1:3710 (no trailing slash).
  {{TRANSFORM_JS}}       — the INLINED_TRANSFORM_JS body. Drop into a
                           <script> as-is; do not modify.

FORBIDDEN

  - External CDNs besides jsDelivr's Drawflow.
  - Any build step, bundler, or framework.
  - POSTing to any origin other than {{API_BASE}}.
  - Removing the chorus-meta hidden node from the Drawflow graph — it
    carries trigger + when-map data.
  - Overwriting user work silently on Load: always confirm if the
    canvas is dirty.

UX RULES

  - Empty canvas = helpful empty state ("Drag an integration from the
    sidebar to start.").
  - Dirty state (unsaved edits) visible in the top bar.
  - Keyboard shortcuts: Ctrl+S save, Delete remove, Ctrl+Z undo (if
    feasible; Drawflow doesn't natively undo, so a best-effort snapshot
    on each change is acceptable).
  - Everything Chorus about a node (integration, operation, Chorus id)
    must remain visible and editable — do not hide it in a side panel.

STYLE

Render the whole thing in this aesthetic: {{STYLE}}

If {{STYLE}} is empty, default to a clean inspector-panel look:
system font, monospace for ids, cool-gray background, thin 1px node
borders, no shadows, dashed lines for conditional (when-expression)
edges.

Return exactly one <!doctype html> code block, no prose before or
after. Keep the file under 800 lines.`;
