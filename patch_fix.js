async function deleteSample(id, btn) {
  if (btn) btn.disabled = true;
  try {
    await fetch(`/api/dataset/delete/${id}`, { method: 'DELETE' });
    await loadDataset();
  } catch {
    if (btn) btn.disabled = false;
  }
}

async function deleteClass() {
  let searchInput = document.getElementById('datasetSearch');
  let label = searchInput ? searchInput.value.trim().toUpperCase() : '';
  
  if (!label) {
    alert('Para mag-delete ng buong class, i-type muna ang pangalan ng class (halimbawa "A") sa Search bar, tapos pindutin ulit ang Delete Class.');
    if (searchInput) searchInput.focus();
    return;
  }
  
  if (!confirm(`Are you sure you want to delete ALL samples for "${label}"?`)) return;
  
  const loadingOverlay = document.createElement('div');
  loadingOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);color:#fff;display:flex;align-items:center;justify-content:center;font-size:1.5rem;z-index:99999;';
  loadingOverlay.innerHTML = `<div>⏳ Deleting all "${label}"... Please wait...</div>`;
  document.body.appendChild(loadingOverlay);

  // Add an intentional delay so the browser has time to render the loading screen
  await new Promise(r => setTimeout(r, 500));

  try {
    const res = await fetch('/api/dataset/delete_class', { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label })
    });
    const data = await res.json();
    document.body.removeChild(loadingOverlay);
    if (data.ok) {
      alert(`✅ Deleted ${data.deleted} samples for class "${label}".`);
      if (searchInput) {
         searchInput.value = '';
      }
      loadDataset();
    } else {
      alert('Error: ' + data.error);
    }
  } catch (e) {
    if (document.body.contains(loadingOverlay)) document.body.removeChild(loadingOverlay);
    alert('Error deleting class');
  }
}
