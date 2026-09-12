/**
 * A minimal MCP test UI: vanilla JS, no build step, no framework. Calls
 * the SAME /mcp JSON-RPC endpoint any real MCP client would -- this page
 * is a convenience for a human, not a special code path the server
 * treats differently.
 */
export const TESTER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>MCP Capability Catalog</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; max-width: 760px; margin: 32px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 18px; }
  .tool { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .tool h2 { font-size: 15px; margin: 0 0 4px; font-family: monospace; }
  .tool p { color: #555; font-size: 13px; margin: 4px 0 12px; }
  label { display: block; font-size: 12px; font-weight: 600; margin-top: 8px; }
  input { width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 13px; margin-top: 2px; }
  button { margin-top: 12px; padding: 6px 16px; font-size: 13px; cursor: pointer; }
  pre { background: #f6f6f6; border-radius: 6px; padding: 10px; font-size: 12px; overflow-x: auto; margin-top: 10px; white-space: pre-wrap; }
  .status { font-size: 12px; color: #888; }
</style>
</head>
<body>
<h1>MCP Capability Catalog</h1>
<p class="status" id="status">Loading tools/list...</p>
<div id="tools"></div>

<script>
async function callRpc(method, params) {
  const res = await fetch('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return res.json();
  const text = await res.text();
  let last = null;
  for (const line of text.split('\\n')) {
    if (!line.startsWith('data:')) continue;
    try { last = JSON.parse(line.slice(5).trim()); } catch (e) {}
  }
  return last;
}

function buildForm(tool) {
  const props = (tool.inputSchema && tool.inputSchema.properties) || {};
  const required = (tool.inputSchema && tool.inputSchema.required) || [];
  const div = document.createElement('div');
  div.className = 'tool';
  const h2 = document.createElement('h2');
  h2.textContent = tool.name;
  const p = document.createElement('p');
  p.textContent = tool.description || '';
  div.appendChild(h2);
  div.appendChild(p);

  const form = document.createElement('form');
  const inputs = {};
  for (const [name, schema] of Object.entries(props)) {
    const label = document.createElement('label');
    label.textContent = name + (required.includes(name) ? ' *' : '') + (schema.description ? ' -- ' + schema.description : '');
    const input = document.createElement('input');
    input.name = name;
    inputs[name] = input;
    form.appendChild(label);
    form.appendChild(input);
  }
  const button = document.createElement('button');
  button.type = 'submit';
  button.textContent = 'Call';
  form.appendChild(button);

  const pre = document.createElement('pre');
  pre.textContent = '(no call made yet)';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    button.disabled = true;
    button.textContent = 'Calling... (this launches a real browser and replays the capability, a few seconds)';
    pre.textContent = 'Calling...';
    const args = {};
    for (const [name, input] of Object.entries(inputs)) if (input.value) args[name] = input.value;
    try {
      const response = await callRpc('tools/call', { name: tool.name, arguments: args });
      const content = response && response.result && response.result.content;
      const text = content && content[0] && content[0].text;
      pre.textContent = text ? JSON.stringify(JSON.parse(text), null, 2) : JSON.stringify(response, null, 2);
    } catch (err) {
      pre.textContent = 'Error: ' + err;
    } finally {
      button.disabled = false;
      button.textContent = 'Call';
    }
  });

  div.appendChild(form);
  div.appendChild(pre);
  return div;
}

(async () => {
  const status = document.getElementById('status');
  const toolsDiv = document.getElementById('tools');
  try {
    const response = await callRpc('tools/list', {});
    const tools = (response && response.result && response.result.tools) || [];
    status.textContent = tools.length + ' tool(s) available.';
    for (const tool of tools) toolsDiv.appendChild(buildForm(tool));
    if (tools.length === 0) status.textContent = 'No tools in the catalog (no verified/approved capabilities found).';
  } catch (err) {
    status.textContent = 'Failed to load tools/list: ' + err;
  }
})();
</script>
</body>
</html>
`;
