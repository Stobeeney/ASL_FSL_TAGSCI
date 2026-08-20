function renderDataset(data = null) {
  const rows = data || datasetCache;
  if (el.datasetCount) el.datasetCount.textContent = `${rows.length} sample${rows.length !== 1 ? 's' : ''}`;
  if (!rows.length) {
    if (el.datasetEmpty) el.datasetEmpty.style.display = '';
    if (el.datasetTableBody) el.datasetTableBody.innerHTML = '';
    return;
  }
  if (el.datasetEmpty) el.datasetEmpty.style.display = 'none';
  if (el.datasetTableBody) {
    // Limit to 100 items to prevent severe lag on mobile
    const displayRows = rows.slice(0, 100);
    let html = displayRows.map(r => `
      <tr>
        <td class="dt-id">#${r.id}</td>
        <td class="dt-label">${r.label}</td>
        <td><span class="dt-badge dt-badge--${(r.mode || 'ASL').toLowerCase()}">${r.mode || 'ASL'}</span></td>
        <td><span class="dt-badge dt-badge--${r.type || 'gesture'}">${r.type || 'gesture'}</span></td>
        <td class="dt-num">${r.frames || 1}</td>
        <td class="dt-time">${r.created_at || ''}</td>
        <td style="display:flex;gap:4px;">
          <button class="dt-play" onclick="openPlayback(${r.id}, '${r.label}', '${r.type || 'gesture'}', ${r.frames || 1})" title="Play">▶</button>
          <button class="dt-del" onclick="deleteSample(${r.id}, this)" title="Delete">✕</button>
        </td>
      </tr>
    `).join('');
    
    if (rows.length > 100) {
       html += `<tr><td colspan="7" style="text-align:center;padding:15px;color:#888;">Showing top 100 samples to prevent lag. Use the search bar to find others.</td></tr>`;
    }
    el.datasetTableBody.innerHTML = html;
  }
}
