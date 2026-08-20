
async function deleteClass() {
  const label = prompt('Enter the exact label of the class you want to delete:');
  if (!label || !label.trim()) return;
  if (!confirm(`Are you sure you want to delete ALL samples for "${label.trim()}"?`)) return;
  
  try {
    const res = await fetch('/api/dataset/delete_class', { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: label.trim() })
    });
    const data = await res.json();
    if (data.ok) {
      alert(`✅ Deleted ${data.deleted} samples for class "${label.trim()}".`);
      loadDataset();
    } else {
      alert('Error: ' + data.error);
    }
  } catch (e) {
    alert('Error deleting class');
  }
}
