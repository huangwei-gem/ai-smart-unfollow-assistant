var sel = document.querySelector('select[data-role="cat"]');
var before = sel.value;
var name = sel.closest('.aiuf-acc, [class*="aiuf"]').querySelector('b, .aiuf-name');
sel.value = '僵尸号';
sel.dispatchEvent(new Event('change', { bubbles: true }));
JSON.stringify({ name: name ? name.textContent : null, before: before, after: sel.value });
