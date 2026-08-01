// public/export-app.js

const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const connectArea = document.getElementById('connectArea');
const exportPanel = document.getElementById('exportPanel');
const designListContainer = document.getElementById('designListContainer');
const fetchMoreContainer = document.getElementById('fetchMoreContainer');
const fetchMoreBtn = document.getElementById('fetchMoreBtn');
const exportResult = document.getElementById('exportResult');

const exportFormatEl = document.getElementById('exportFormat');
const downloadBtn = document.getElementById('downloadBtn');
const downloadTxtBtn = document.getElementById('downloadTxtBtn');
const selectAllBtn = document.getElementById('selectAllBtn');
const gitLfsBtn = document.getElementById('gitLfsBtn');
const downloadAllBatBtn = document.getElementById('downloadAllBatBtn');
const downloadThumbsBatBtn = document.getElementById('downloadThumbsBatBtn');
const selectedCountEl = document.getElementById('selectedCount');
const selectionStatusEl = document.getElementById('selectionStatus');

let allDesigns = [];
let selectedDesigns = new Set();
let lastExportResults = null; // Store CDN URLs for TXT download
let continuationToken = null; // For pagination
let isLoadingDesigns = false;

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

async function loadDesigns(isAppend = false) {
  if (isLoadingDesigns) return;
  
  isLoadingDesigns = true;
  if (!isAppend) {
    designListContainer.innerHTML = '<div class="loading">Loading designs…</div>';
  }
  
  try {
    const url = `/api/designs/list?limit=5${continuationToken ? `&continuation=${encodeURIComponent(continuationToken)}` : ''}`;
    const res = await fetch(url);
    const data = await res.json();
    
    console.log('[DEBUG] Received from /api/designs/list:', data);
    
    if (!res.ok) {
      throw new Error(data.error || 'Failed to load designs');
    }
    
    if (isAppend) {
      allDesigns = [...allDesigns, ...(data.designs || [])];
    } else {
      allDesigns = data.designs || [];
    }
    
    continuationToken = data.continuation || null;
    
    console.log('[DEBUG] Loaded designs count:', allDesigns.length, 'hasMore:', data.hasMore);
    renderDesignList();
    
    // Show/hide fetch more button
    if (data.hasMore) {
      fetchMoreContainer.style.display = 'block';
      fetchMoreBtn.disabled = false;
      fetchMoreBtn.textContent = 'Fetch More Designs';
    } else {
      fetchMoreContainer.style.display = 'none';
    }
  } catch (err) {
    console.error('[ERROR] loadDesigns failed:', err);
    if (!isAppend) {
      designListContainer.innerHTML = `<div class="error">Error loading designs: ${err.message}</div>`;
    } else {
      fetchMoreBtn.textContent = 'Error - Retry';
      fetchMoreBtn.disabled = false;
    }
  } finally {
    isLoadingDesigns = false;
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
    const thumbnailUrl = design.thumbnail?.url;
    const pageCount = design.page_count || 1;
    
    html += `
      <div class="design-item" id="design-item-${design.id}">
        <div class="design-header">
          <input type="checkbox" id="design-${design.id}" value="${design.id}" />
          ${thumbnailUrl 
            ? `<img src="${thumbnailUrl}" alt="Thumbnail" class="design-thumbnail" loading="lazy" />`
            : `<div class="design-thumbnail-placeholder">No preview</div>`
          }
          <div class="design-info">
            <div class="design-title">${escapeHtml(title)} <span class="design-type">${escapeHtml(designType)}</span></div>
            <div class="design-meta">ID: ${design.id}${createdAt ? ' • Created: ' + createdAt : ''}${pageCount > 1 ? ` • ${pageCount} slides` : ''}</div>
          </div>
        </div>
        ${pageCount > 1 ? `
        <div class="slides-container slides-hidden" id="slides-container-${design.id}">
          <div class="slides-header">
            <span class="slides-title">${pageCount} slides/pages</span>
            <button class="slide-toggle-btn" onclick="toggleSlides('${design.id}')">Show All Slides</button>
          </div>
          <div class="slides-grid" id="slides-grid-${design.id}">
            <div class="loading">Loading slides...</div>
          </div>
        </div>
        ` : ''}
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

// Toggle slides visibility and load slides on demand
window.toggleSlides = async function(designId) {
  const container = document.getElementById(`slides-container-${designId}`);
  const grid = document.getElementById(`slides-grid-${designId}`);
  const toggleBtn = container.querySelector('.slide-toggle-btn');
  
  if (container.classList.contains('slides-hidden')) {
    // Show slides - load them if not already loaded
    if (grid.querySelector('.loading') || grid.querySelector('.slide-item') === null) {
      try {
        const res = await fetch(`/api/designs/${designId}/pages`);
        const data = await res.json();
        
        if (!res.ok) {
          throw new Error(data.error || 'Failed to load slides');
        }
        
        const pages = data.pages || [];
        if (pages.length === 0) {
          grid.innerHTML = '<div class="empty-state">No slides available</div>';
        } else {
          let slideHtml = '';
          pages.forEach((page, index) => {
            const pageThumbnail = page.thumbnail?.url;
            slideHtml += `
              <div class="slide-item">
                ${pageThumbnail 
                  ? `<img src="${pageThumbnail}" alt="Slide ${index + 1}" class="slide-thumbnail" loading="lazy" />`
                  : `<div class="slide-thumbnail-placeholder">No preview</div>`
                }
                <div class="slide-footer">
                  <span class="slide-number">Slide ${index + 1}</span>
                  <button class="slide-download-btn" onclick="downloadSlide('${designId}', '${page.id || index}')">Download</button>
                </div>
              </div>
            `;
          });
          grid.innerHTML = slideHtml;
        }
      } catch (err) {
        console.error('Failed to load slides:', err);
        grid.innerHTML = `<div class="error">Failed to load slides: ${err.message}</div>`;
      }
    }
    container.classList.remove('slides-hidden');
    toggleBtn.textContent = 'Hide Slides';
  } else {
    // Hide slides
    container.classList.add('slides-hidden');
    toggleBtn.textContent = 'Show All Slides';
  }
};

// Download individual slide
window.downloadSlide = async function(designId, pageId) {
  const format = exportFormatEl.value;
  try {
    const res = await fetch('/api/exports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        designId,
        format,
        pageId: pageId !== String(parseInt(pageId)) ? pageId : undefined // Only send if it's a string ID
      }),
    });
    
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    
    const job = data.job;
    if (job.status === 'success' && job.urls && job.urls.length > 0) {
      const url = job.urls[0];
      const a = document.createElement('a');
      a.href = url;
      a.download = `${designId}_slide_${pageId}.${format}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.click();
    } else {
      alert('Export failed or no download URL returned');
    }
  } catch (err) {
    console.error('Slide download failed:', err);
    alert(`Failed to download slide: ${err.message}`);
  }
};

// Fetch More button handler
fetchMoreBtn?.addEventListener('click', () => {
  fetchMoreBtn.disabled = true;
  fetchMoreBtn.textContent = 'Loading...';
  loadDesigns(true); // true = append to existing list
});

// Select All button handler
selectAllBtn.addEventListener('click', () => {
  const checkboxes = document.querySelectorAll('.design-item input[type="checkbox"]');
  const allSelected = Array.from(checkboxes).every(cb => cb.checked);
  
  checkboxes.forEach(checkbox => {
    checkbox.checked = !allSelected;
    if (checkbox.checked) {
      selectedDesigns.add(checkbox.value);
    } else {
      selectedDesigns.delete(checkbox.value);
    }
  });
  
  selectAllBtn.textContent = allSelected ? 'Select All' : 'Deselect All';
  updateSelectionUI();
});

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
  downloadTxtBtn.disabled = count === 0 || !lastExportResults;
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
    const res = await fetch('/api/exports/batch-sequential', {
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
    
    // Store results for TXT download
    lastExportResults = data.results.filter(r => r.status === 'success');
    
    // Display results with CDN URLs
    let html = '<div style="margin-bottom: 12px;"><strong>Export Results:</strong></div>';
    html += '<div style="font-size: 12px; color: #9aa0ab; margin-bottom: 12px;">Files are hosted on Canva CDN. Right-click links and select "Save As" to download, or use the "Download TXT" button to get a script for Windows CMD.</div>';
    
    if (data.results && data.results.length > 0) {
      const successResults = data.results.filter(r => r.status === 'success');
      const failedResults = data.results.filter(r => r.status === 'failed');
      
      if (successResults.length > 0) {
        html += `<div class="export-success" style="margin-bottom: 16px; padding: 12px; border-radius: 8px;">`;
        html += `<div style="color: #3ecf6f; font-weight: 500; margin-bottom: 8px;">✓ ${successResults.length} successful export(s)</div>`;
        html += `<div style="max-height: 400px; overflow-y: auto;">`;
        successResults.forEach((result, i) => {
          const design = allDesigns.find(d => d.id === result.designId);
          const title = design ? (design.title || '(untitled)') : result.designId;
          
          if (result.urls && result.urls.length > 0) {
            html += `<div style="margin-bottom: 12px; padding: 8px; background: #0f1115; border-radius: 6px;">`;
            html += `<div style="margin-bottom: 6px; font-weight: 500;">${escapeHtml(title)}</div>`;
            result.urls.forEach((url, j) => {
              const filename = `${result.designId}_${j + 1}.${format}`;
              html += `<div style="margin-left: 12px; font-size: 12px; margin-bottom: 4px;">`;
              html += `<a href="${url}" target="_blank" rel="noopener" download="${filename}" class="download-link">⬇ Download ${j + 1}</a>`;
              html += ` <span style="color: #666;">|</span> `;
              html += `<button class="copy-url-btn" onclick="navigator.clipboard.writeText('${url}').then(() => alert('URL copied!')).catch(err => console.error('Copy failed:', err)); return false;">📋 Copy URL</button>`;
              html += `</div>`;
            });
            html += `</div>`;
          }
        });
        html += `</div></div>`;
      }
      
      if (failedResults.length > 0) {
        html += `<div class="export-failed" style="margin-bottom: 16px; padding: 12px; border-radius: 8px;">`;
        html += `<div style="color: #e5484d; font-weight: 500; margin-bottom: 8px;">✗ ${failedResults.length} failed export(s)</div>`;
        failedResults.forEach(result => {
          const design = allDesigns.find(d => d.id === result.designId);
          const title = design ? (design.title || '(untitled)') : result.designId;
          html += `<div style="font-size: 13px; color: #e5484d;">${escapeHtml(title)}: ${result.error?.message || 'unknown error'}</div>`;
        });
        html += `</div>`;
      }
    }
    
    exportResult.innerHTML = html;
    exportResult.style.display = 'block';
    
    // Update TXT button state
    updateSelectionUI();
    
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

// Git LFS Export button handler
gitLfsBtn.addEventListener('click', async () => {
  if (selectedDesigns.size === 0) {
    alert('Please select at least one design to export');
    return;
  }
  
  const format = exportFormatEl.value;
  const repoName = prompt('Enter repository name:', 'canva-exports');
  if (!repoName) return;
  
  gitLfsBtn.disabled = true;
  gitLfsBtn.textContent = 'Processing...';
  exportResult.style.display = 'none';
  
  try {
    const res = await fetch('/api/exports/git-lfs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        designIds: Array.from(selectedDesigns), 
        format,
        repoName
      }),
    });
    
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    
    // Display Git LFS instructions
    let html = '<div style="margin-bottom: 12px;"><strong>Git LFS Export Ready</strong></div>';
    html += `<div style="padding: 12px; background: #1a2d3d; border-radius: 8px; border: 1px solid #7c5cff; margin-bottom: 16px;">`;
    html += `<div style="font-weight: 500; margin-bottom: 8px;">Processed ${data.totalProcessed} designs (${data.successCount} successful)</div>`;
    html += `<div style="font-size: 13px; line-height: 1.6;">`;
    html += `<strong>Setup Instructions:</strong><br/>`;
    html += `1. Create a new Git repository: <code>git init ${repoName}</code><br/>`;
    html += `2. Initialize Git LFS: <code>git lfs install</code><br/>`;
    html += `3. Create .gitattributes file with the tracking info below<br/>`;
    html += `4. Use the provided CDN URLs to download files into the repo<br/>`;
    html += `5. Commit and push to your remote<br/>`;
    html += `</div></div>`;
    
    html += `<div style="margin-bottom: 8px;"><strong>.gitattributes content:</strong></div>`;
    html += `<pre style="background: #0f1115; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; max-height: 300px; overflow-y: auto;">`;
    html += escapeHtml(data.lfsTracking);
    html += `</pre>`;
    
    html += `<div style="margin-top: 16px;"><strong>Download Script (bash):</strong></div>`;
    html += `<pre style="background: #0f1115; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 12px; max-height: 300px; overflow-y: auto;">`;
    const downloadScript = data.results
      .filter(r => r.status === 'success' && r.urls.length > 0)
      .map((result, i) => {
        const url = result.urls[0];
        const filename = `${result.designId}.${format}`;
        return `curl -L "${url}" -o "${filename}"`;
      })
      .join('\n');
    html += escapeHtml(downloadScript);
    html += `</pre>`;
    
    exportResult.innerHTML = html;
    exportResult.style.display = 'block';
    
  } catch (err) {
    exportResult.textContent = 'Error: ' + err.message;
    exportResult.style.display = 'block';
  } finally {
    gitLfsBtn.disabled = false;
    gitLfsBtn.textContent = 'Git LFS Export';
  }
});

// Download TXT button handler - generates Windows CMD script with CDN URLs
downloadTxtBtn.addEventListener('click', () => {
  if (!lastExportResults || lastExportResults.length === 0) {
    alert('No export results available. Please run an export first.');
    return;
  }
  
  const format = exportFormatEl.value;
  
  // Generate Windows CMD script with CDN URLs
  let cmdScript = '@echo off\r\n';
  cmdScript += 'REM Canva CDN Download Script\r\n';
  cmdScript += 'REM Run this file in Windows Command Prompt to download all exported files\r\n';
  cmdScript += 'REM Files will be downloaded one at a time for better performance and reliability\r\n';
  cmdScript += '\r\n';
  cmdScript += `echo Starting download of ${lastExportResults.length} file(s)...\r\n`;
  cmdScript += 'echo Files will be downloaded sequentially to avoid connection issues\r\n';
  cmdScript += '\r\n';
  
  let fileIndex = 1;
  const totalFiles = lastExportResults.reduce((sum, result) => sum + (result.urls ? result.urls.length : 0), 0);
  
  lastExportResults.forEach((result) => {
    const design = allDesigns.find(d => d.id === result.designId);
    const title = design ? (design.title || '(untitled)') : result.designId;
    
    if (result.urls && result.urls.length > 0) {
      result.urls.forEach((url, j) => {
        const filename = `${result.designId}_${j + 1}.${format}`;
        cmdScript += `echo [${fileIndex}/${totalFiles}] Downloading: ${filename}\r\n`;
        cmdScript += `curl -L "${url}" -o "${filename}"\r\n`;
        cmdScript += `if errorlevel 1 echo Warning: Failed to download ${filename}\r\n`;
        cmdScript += '\r\n';
        fileIndex++;
      });
    }
  });
  
  cmdScript += '\r\n';
  cmdScript += 'echo.\r\n';
  cmdScript += 'echo All downloads complete!\r\n';
  cmdScript += 'echo Press any key to exit...\r\n';
  cmdScript += 'pause > nul\r\n';
  
  // Create and download the TXT file
  const blob = new Blob([cmdScript], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `canva-download-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.bat`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// Download ALL Designs (.bat) button handler — no selection needed.
// Server fetches every design via the Canva API, exports each one, and
// streams back a ready-to-run Windows .bat file.
downloadAllBatBtn.addEventListener('click', async () => {
  const format = exportFormatEl.value;
  const originalText = downloadAllBatBtn.textContent;

  const confirmed = confirm(
    `This will export every design in your Canva account as ${format.toUpperCase()} and build a ` +
    `.bat file to download them all. This can take a while for large accounts. Continue?`
  );
  if (!confirmed) return;

  downloadAllBatBtn.disabled = true;
  downloadAllBatBtn.textContent = 'Exporting all designs… this can take a while';
  exportResult.style.display = 'none';

  try {
    const res = await fetch(`/api/exports/all-as-bat?format=${encodeURIComponent(format)}`);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `canva-download-all-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.bat`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    exportResult.innerHTML =
      '<div style="color:var(--success)">✓ .bat file downloaded. Double-click it on Windows — it will ' +
      'create a "canva-downloads" folder next to itself and download every design into it.</div>';
    exportResult.style.display = 'block';
  } catch (err) {
    exportResult.textContent = 'Error: ' + err.message;
    exportResult.style.display = 'block';
  } finally {
    downloadAllBatBtn.disabled = false;
    downloadAllBatBtn.textContent = originalText;
  }
});

// Download ALL Thumbnails (.bat) button — rate-limit-free. Uses the
// thumbnail URL already included in the design list response, so it never
// calls Canva's /exports endpoint and never hits the 75/5min export cap.
downloadThumbsBatBtn.addEventListener('click', async () => {
  const originalText = downloadThumbsBatBtn.textContent;
  downloadThumbsBatBtn.disabled = true;
  downloadThumbsBatBtn.textContent = 'Building script…';
  exportResult.style.display = 'none';

  try {
    const res = await fetch('/api/designs/thumbnails-bat');

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed (${res.status})`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `canva-thumbnails-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.bat`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    exportResult.innerHTML =
      '<div style="color:var(--success)">✓ .bat file downloaded. Double-click it on Windows — it will ' +
      'create a "canva-thumbnails" folder and download every design\'s thumbnail into it. No rate limit, ' +
      'but these are preview-quality images, not full exports.</div>';
    exportResult.style.display = 'block';
  } catch (err) {
    exportResult.textContent = 'Error: ' + err.message;
    exportResult.style.display = 'block';
  } finally {
    downloadThumbsBatBtn.disabled = false;
    downloadThumbsBatBtn.textContent = originalText;
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
