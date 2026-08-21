async function importDataset(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;

  const modal = $('importModal');
  const title = $('importModalTitle');
  const sub = $('importModalSub');
  const pBar = $('importProgressBar');
  const counter = $('importCounter');
  const closeBtn = $('importCloseBtn');
  const icon = document.querySelector('.import-icon');
  const spinner = document.querySelector('.import-spinner');

  if (modal) modal.style.display = 'flex';
  if (title) title.textContent = 'Reading JSON File...';
  if (sub) sub.textContent = `File: ${file.name}`;
  if (pBar) pBar.style.width = '5%';
  if (counter) counter.textContent = 'Preparing streaming import...';
  if (closeBtn) closeBtn.style.display = 'none';
  if (spinner) spinner.style.display = 'block';
  if (icon) icon.textContent = '📥';

  try {
    const FILE_SIZE = file.size;
    const CHUNK_SIZE = 512 * 1024; // 512 KB chunks for memory safety
    let offset = 0;
    let buffer = '';
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let objectStart = -1;
    let totalImported = 0;

    let batch = [];
    const BATCH_LIMIT = 25;

    async function flushBatch() {
      if (batch.length === 0) return;
      const res = await fetch('/api/dataset/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch)
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Import failed');
      totalImported += (data.imported !== undefined ? data.imported : batch.length);
      batch = [];
    }

    while (offset < FILE_SIZE) {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const text = await slice.text();
      buffer += text;
      offset += CHUNK_SIZE;

      if (title) title.textContent = 'Importing & Merging Dataset...';
      const progressPct = Math.min(100, Math.round((offset / FILE_SIZE) * 100));
      if (pBar) pBar.style.width = `${progressPct}%`;
      if (sub) sub.textContent = `Processing file chunk... ${progressPct}%`;
      if (counter) counter.textContent = `${totalImported} samples imported so far`;

      let i = 0;
      while (i < buffer.length) {
        const char = buffer[i];
        if (escapeNext) {
          escapeNext = false;
          i++;
          continue;
        }
        if (char === '"') {
          inString = !inString;
        } else if (char === '\\' && inString) {
          escapeNext = true;
        } else if (!inString) {
          if (char === '{') {
            if (depth === 0) objectStart = i;
            depth++;
          } else if (char === '}') {
            depth--;
            if (depth === 0 && objectStart !== -1) {
              const objStr = buffer.substring(objectStart, i + 1);
              try {
                batch.push(JSON.parse(objStr));
              } catch(e) {
                console.error("Skipped malformed object");
              }
              buffer = buffer.substring(i + 1);
              i = -1; 
              objectStart = -1;

              if (batch.length >= BATCH_LIMIT) {
                await flushBatch();
                if (counter) counter.textContent = `${totalImported} samples imported so far`;
              }
            }
          }
        }
        i++;
      }
    }
    
    // Flush remaining
    await flushBatch();

    // Success State Animation
    if (title) title.textContent = 'Import Complete!';
    if (sub) sub.textContent = 'Dataset has been merged successfully.';
    if (pBar) pBar.style.width = '100%';
    if (pBar) pBar.style.background = '#4cd964';
    if (counter) counter.textContent = `Total Imported: ${totalImported}`;
    if (spinner) spinner.style.display = 'none';
    if (icon) icon.textContent = '✅';
    if (closeBtn) {
      closeBtn.style.display = 'inline-block';
      closeBtn.textContent = 'Finish';
    }

    if (input) input.value = '';
    loadDataset();

  } catch(err) {
    if (title) title.textContent = 'Import Failed';
    if (sub) sub.textContent = err.message || 'Unknown error occurred.';
    if (spinner) spinner.style.display = 'none';
    if (icon) icon.textContent = '❌';
    if (pBar) pBar.style.background = '#ff3b30';
    if (closeBtn) closeBtn.style.display = 'inline-block';
    if (input) input.value = '';
    alert('Import Error: ' + err.message);
  }
}
