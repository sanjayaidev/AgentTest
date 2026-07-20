// public/export-app.js

const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const connectArea = document.getElementById('connectArea');
const exportPanel = document.getElementById('exportPanel');
const designListContainer = document.getElementById('designListContainer');
const exportResult = document.getElementById('exportResult');

const exportFormatEl = document.getElementById('exportFormat');
const downloadBtn = document.getElementById('downloadBtn');
const selectedCountEl = document.getElementById('selectedCount');
const selectionStatusEl = document.getElementById('selectionStatus');

let allDesigns = [];
let selectedDesigns = new Set();

async function refreshStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    render(data.connected);
    if (data.connected) {
      loadDesigns();
    }
  } catch {
    statusText.textContent = 'status check failed';
  }
}

function render(connected) {
  statusEl.className = 'status ' + (connected ? 'connected' : 'off');
  statusText.textContent = connected ? 'Canva connected' : 'Not connected';
  connectArea.style.display = connected ? 'none' : 'block';
  exportPanel.style.display = connected ? 'block' : 'none';
}

async function loadDesigns() {
  try {
    const res = await fetch('/api/designs/list');
    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.error || 'Failed to load designs');
    }
    
    allDesigns = data.designs || [];
    renderDesignList();
  } catch (err) {
    designListContainer.innerHTML = `<div class="error">Error loading designs: ${err.message}</div>`;
  }
}

function renderDesignList() {
  if (allDesigns.length === 0) {
    designListContainer.innerHTML = `
      <div class="empty-state">
        <p>No designs found.</p>
        <p><a href="/">Create your first design →</a></p>
      </div>
    `;
    updateSelectionUI();
    return;
  }
  
  let html = '<div class="design-list">';
  allDesigns.forEach(design => {
    const title = design.title || '(untitled)';
    const designType = design.design_type?.name || design.design_type?.type || 'unknown';
    const createdAt = design.created_at ? new Date(design.created_at).toLocaleDateString() : '';
    
    html += `
      <div class="design-item">
        <input type="checkbox" id="design-${design.id}" value="${design.id}" />
        <div class="design-info">
          <div class="design-title">${escapeHtml(title)} <span class="design-type">${escapeHtml(designType)}</span></div>
          <div class="design-meta">ID: ${design.id}${createdAt ? ' • Created: ' + createdAt : ''}</div>
        </div>
      </div>
    `;
  });
  html += '</div>';
  
  designListContainer.innerHTML = html;
  
  // Attach checkbox listeners
  document.querySelectorAll('.design-item input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', handleCheckboxChange);
  });
  
  updateSelectionUI();
}

function handleCheckboxChange(e) {
  const designId = e.target.value;
  if (e.target.checked) {
    selectedDesigns.add(designId);
  } else {
    selectedDesigns.delete(designId);
  }
  updateSelectionUI();
}

function updateSelectionUI() {
  const count = selectedDesigns.size;
  selectedCountEl.textContent = count;
  downloadBtn.disabled = count === 0;
  selectionStatusEl.textContent = count > 0 ? `${count} design(s) selected` : '';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

downloadBtn.addEventListener('click', async () => {
  if (selectedDesigns.size === 0) return;
  
  const format = exportFormatEl.value;
  downloadBtn.disabled = true;
  downloadBtn.textContent = 'Exporting...';
  exportResult.style.display = 'none';
  
  try {
    const res = await fetch('/api/exports/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        designIds: Array.from(selectedDesigns), 
        format 
      }),
    });
    
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    
    // Display results
    let html = '<div style="margin-bottom: 12px;"><strong>Export Results:</strong></div>';
    
    if (data.results && data.results.length > 0) {
      data.results.forEach((result, i) => {
        const design = allDesigns.find(d => d.id === result.designId);
        const title = design ? (design.title || '(untitled)') : result.designId;
        
        if (result.status === 'success' && result.urls && result.urls.length > 0) {
          html += `<div style="margin-bottom: 8px; padding: 8px; background: #0f1115; border-radius: 6px;">`;
          html += `<div style="margin-bottom: 4px;"><strong>${escapeHtml(title)}</strong></div>`;
          result.urls.forEach((url, j) => {
            html += `<div style="margin-left: 12px; font-size: 12px;"><a href="${url}" target="_blank" rel="noopener">Download ${j + 1} →</a></div>`;
          });
          html += `</div>`;
        } else if (result.status === 'failed') {
          html += `<div style="margin-bottom: 8px; padding: 8px; background: #0f1115; border-radius: 6px; color: #e5484d;">`;
          html += `<div><strong>${escapeHtml(title)}</strong> - Failed: ${result.error?.message || 'unknown error'}</div>`;
          html += `</div>`;
        }
      });
    }
    
    exportResult.innerHTML = html;
    exportResult.style.display = 'block';
    
    // Clear selection after successful export
    selectedDesigns.clear();
    document.querySelectorAll('.design-item input[type="checkbox"]').forEach(cb => cb.checked = false);
    updateSelectionUI();
    
  } catch (err) {
    exportResult.textContent = 'Error: ' + err.message;
    exportResult.style.display = 'block';
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.innerHTML = `Download Selected (<span id="selectedCount">0</span>)`;
    // Re-attach the count element reference since we replaced innerHTML
    setTimeout(() => {
      const newCountEl = document.getElementById('selectedCount');
      if (newCountEl) {
        newCountEl.textContent = selectedDesigns.size;
      }
    }, 0);
  }
});

// Popup window for OAuth
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

refreshStatus();
