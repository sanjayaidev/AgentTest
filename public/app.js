// public/app.js

const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const connectArea = document.getElementById('connectArea');
const createPanel = document.getElementById('createPanel');
const exportPanel = document.getElementById('exportPanel');
const disconnectPanel = document.getElementById('disconnectPanel');

const createBtn = document.getElementById('createBtn');
const createResult = document.getElementById('createResult');
const designTypeEl = document.getElementById('designType');
const designTitleEl = document.getElementById('designTitle');

const exportBtn = document.getElementById('exportBtn');
const exportResult = document.getElementById('exportResult');
const designIdEl = document.getElementById('designId');
const exportFormatEl = document.getElementById('exportFormat');

const disconnectBtn = document.getElementById('disconnectBtn');

async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    render(data.connected);
  } catch {
    statusText.textContent = 'status check failed';
  }
}

function render(connected) {
  statusEl.className = 'status ' + (connected ? 'connected' : 'off');
  statusText.textContent = connected ? 'Canva connected' : 'Not connected';
  connectArea.style.display = connected ? 'none' : 'block';
  createPanel.style.display = connected ? 'block' : 'none';
  exportPanel.style.display = connected ? 'block' : 'none';
  disconnectPanel.style.display = connected ? 'block' : 'none';
}

// If the OAuth callback ran in a popup, it posts a message back here.
window.addEventListener('message', (e) => {
  if (e.data === 'canva-connected') refreshStatus();
});

createBtn.addEventListener('click', async () => {
  createBtn.disabled = true;
  createBtn.textContent = 'Creating…';
  createResult.style.display = 'none';
  try {
    const res = await fetch('/api/designs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        designType: designTypeEl.value,
        title: designTitleEl.value.trim() || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    designIdEl.value = data.design.id;
    createResult.innerHTML = `Created "<strong>${data.design.title || '(untitled)'}</strong>" — <a href="${data.design.urls.edit_url}" target="_blank" rel="noopener">Open in Canva to edit →</a>`;
    createResult.style.display = 'block';
  } catch (err) {
    createResult.textContent = 'Error: ' + err.message;
    createResult.style.display = 'block';
  } finally {
    createBtn.disabled = false;
    createBtn.textContent = 'Create design';
  }
});

exportBtn.addEventListener('click', async () => {
  const designId = designIdEl.value.trim();
  if (!designId) {
    exportResult.textContent = 'Enter or create a design ID first.';
    exportResult.style.display = 'block';
    return;
  }

  exportBtn.disabled = true;
  exportBtn.textContent = 'Exporting… (this can take a bit)';
  exportResult.style.display = 'none';
  try {
    const res = await fetch('/api/exports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ designId, format: exportFormatEl.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    const job = data.job;
    if (job.status === 'success') {
      const links = (job.urls || []).map((u, i) => `<a href="${u}" target="_blank" rel="noopener">Download ${i + 1} →</a>`).join('<br/>');
      exportResult.innerHTML = links || 'Done, but no download URL returned.';
    } else {
      exportResult.textContent = `Export failed: ${job.error?.message || 'unknown error'}`;
    }
    exportResult.style.display = 'block';
  } catch (err) {
    exportResult.textContent = 'Error: ' + err.message;
    exportResult.style.display = 'block';
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = 'Export design';
  }
});
// In public/app.js, add this event listener
document.getElementById('connectBtn').addEventListener('click', function(e) {
  e.preventDefault();
  const width = 600;
  const height = 700;
  const left = (window.innerWidth - width) / 2;
  const top = (window.innerHeight - height) / 2;
  window.open(
    this.href,
    'Connect Canva',
    `width=${width},height=${height},left=${left},top=${top}`
  );
});
disconnectBtn.addEventListener('click', async () => {
  await fetch('/api/disconnect', { method: 'POST' });
  refreshStatus();
});

refreshStatus();
// Add these functions to public/app.js

const capabilitiesBtn = document.getElementById('capabilitiesBtn');
const capabilitiesResult = document.getElementById('capabilitiesResult');
const capabilitiesList = document.getElementById('capabilitiesList');

capabilitiesBtn?.addEventListener('click', async () => {
  capabilitiesBtn.disabled = true;
  capabilitiesBtn.textContent = 'Checking...';
  capabilitiesResult.style.display = 'none';
  
  try {
    const res = await fetch('/api/capabilities');
    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.error || 'Failed to check capabilities');
    }
    
    // Build the display
    let html = `
      <div style="margin-bottom: 12px;">
        <strong>Status:</strong> ${data.connected ? '✅ Connected' : '❌ Not connected'}
      </div>
      <div style="margin-bottom: 12px;">
        <strong>Features available:</strong>
        <ul style="margin: 8px 0 0 20px; line-height: 1.8;">
    `;
    
    const features = [
      { key: 'hasAutofill', label: 'Autofill (Brand Templates)', emoji: '✅' },
      { key: 'hasBrandTemplate', label: 'Brand Template Access', emoji: '✅' },
      { key: 'hasResize', label: 'Resize (Premium feature)', emoji: '✅' }
    ];
    
    let hasAny = false;
    features.forEach(f => {
      if (data[f.key]) {
        html += `<li>${f.emoji} ${f.label}</li>`;
        hasAny = true;
      }
    });
    
    if (!hasAny) {
      html += `<li>⚠️ No premium/enterprise features detected. You have a Canva ${data.capabilities?.length > 0 ? 'free' : 'basic'} account.</li>`;
    }
    
    html += `</ul></div>`;
    
    // Show all capabilities
    if (data.capabilities && data.capabilities.length > 0) {
      html += `
        <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #2a2e38;">
          <strong>All capabilities:</strong>
          <div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px;">
            ${data.capabilities.map(c => `<span style="background: #1a1e26; padding: 4px 12px; border-radius: 12px; font-size: 12px;">${c}</span>`).join('')}
          </div>
        </div>
      `;
    } else {
      html += `
        <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #2a2e38; color: #9aa0ab;">
          No capabilities found. You may be on a free Canva account.
        </div>
      `;
    }
    
    capabilitiesList.innerHTML = html;
    capabilitiesResult.style.display = 'block';
    
  } catch (err) {
    capabilitiesList.innerHTML = `<div style="color: #e5484d;">Error: ${err.message}</div>`;
    capabilitiesResult.style.display = 'block';
  } finally {
    capabilitiesBtn.disabled = false;
    capabilitiesBtn.textContent = 'Check Canva Capabilities';
  }
});
