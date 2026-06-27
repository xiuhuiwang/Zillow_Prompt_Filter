const fields = ['minSqftPerBed', 'maxPricePerSqft', 'excludeKeywords'];

async function load() {
  const { zefCriteria } = await chrome.storage.sync.get('zefCriteria');
  if (!zefCriteria) return;
  if (zefCriteria.minSqftPerBed) document.getElementById('minSqftPerBed').value = zefCriteria.minSqftPerBed;
  if (zefCriteria.maxPricePerSqft) document.getElementById('maxPricePerSqft').value = zefCriteria.maxPricePerSqft;
  if (zefCriteria.excludeKeywords) document.getElementById('excludeKeywords').value = zefCriteria.excludeKeywords.join(', ');
}

async function save() {
  const criteria = {
    minSqftPerBed: parseFloat(document.getElementById('minSqftPerBed').value) || null,
    maxPricePerSqft: parseFloat(document.getElementById('maxPricePerSqft').value) || null,
    excludeKeywords: document
      .getElementById('excludeKeywords')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };

  await chrome.storage.sync.set({ zefCriteria: criteria });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'ZEF_REAPPLY' }).catch(() => {});
  }

  const status = document.getElementById('status');
  status.textContent = 'Applied.';
  setTimeout(() => (status.textContent = ''), 1500);
}

document.getElementById('apply').addEventListener('click', save);
load();
