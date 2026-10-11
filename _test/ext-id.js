chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }).then(list => {
  const e = list.find(x => x.name.includes('AI') && x.name.includes('取关'));
  return e ? JSON.stringify({ id: e.id, name: e.name, version: e.version, state: e.state }) : JSON.stringify(list.map(x => x.name).slice(0, 20));
});
