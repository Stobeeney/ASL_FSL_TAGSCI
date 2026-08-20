async function deleteClass() {
  let searchInput = document.getElementById('datasetSearch');
  let label = searchInput ? searchInput.value.trim().toUpperCase() : '';
  
  if (!label) {
    alert('Para mag-delete ng buong class, i-type muna ang pangalan ng class (halimbawa "A") sa Search bar, tapos pindutin ulit ang Delete Class.');
    if (searchInput) searchInput.focus();
    return;
  }
  
  if (!confirm(`Are you sure you want to delete ALL samples for "${label}"?`)) return;
  
  try {
    const res = await fetch('/api/dataset/delete_class', { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label })
    });
    const data = await res.json();
    if (data.ok) {
      alert(`✅ Deleted ${data.deleted} samples for class "${label}".`);
      if (searchInput) searchInput.value = '';
      loadDataset();
    } else {
      alert('Error: ' + data.error);
    }
  } catch (e) {
    alert('Error deleting class');
  }
}
