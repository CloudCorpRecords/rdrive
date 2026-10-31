'use strict';

// RDocs: the built-in document editor for .rdoc files (and a viewer for Word/OpenDocument files).
// Content lives in a contenteditable page; everything that goes in or out is sanitized by
// RDriveInterop.sanitizeHtml, and exports go through public/interop.js.
(function () {
  const I = () => window.RDriveInterop;
  const toast = (m) => window.rdriveToast && window.rdriveToast(m);

  const EXPORTS = {
    docx: { label: 'Word', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    odt: { label: 'OpenDocument', mime: 'application/vnd.oasis.opendocument.text' },
    md: { label: 'Markdown', mime: 'text/markdown;charset=utf-8' },
    html: { label: 'web page', mime: 'text/html;charset=utf-8' },
    txt: { label: 'plain text', mime: 'text/plain;charset=utf-8' },
  };

  function baseName(name) {
    return String(name || 'Document').replace(/\.[^.]+$/, '') || 'Document';
  }

  // Converts sanitized HTML into a file of the given kind. Returns a Blob.
  async function exportBlob(kind, name, html) {
    const interop = I();
    const clean = interop.sanitizeHtml(html);
    let data;
    if (kind === 'docx') data = await interop.htmlToDocx(clean, { ...(await interop.load('docx')), DOMParser });
    else if (kind === 'odt') data = await interop.htmlToOdt(clean, { ...(await interop.load('JSZip')), DOMParser });
    else if (kind === 'md') data = interop.htmlToMarkdown(clean);
    else if (kind === 'html') data = interop.htmlDocument(baseName(name), clean);
    else if (kind === 'txt') data = interop.htmlToText(clean);
    else throw new Error('Unknown format.');
    return data instanceof Blob ? data : new Blob([data], { type: EXPORTS[kind].mime });
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function wordCount(text) {
    const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
    return `${words.toLocaleString()} word${words === 1 ? '' : 's'} · ${text.length.toLocaleString()} characters`;
  }

  /**
   * Opens the editor.
   *  name        file name shown in the title
   *  readOnly    view only (Word/ODT files, view-only share links)
   *  loadHtml    async () => html
   *  saveHtml    async (html) => void        (omit when readOnly)
   *  saveCopy    async (fileName, blob) => savedName   ("Save a copy in this folder"; optional)
   *  banner      { text, actionLabel, onAction }       (optional notice above the page)
   *  onSaved     () => void                            (optional)
   */
  function openDocModal({ name, readOnly = false, loadHtml, saveHtml, saveCopy, banner, onSaved }) {
    const $ = (id) => document.getElementById(id);
    const dlg = $('doc-dialog');
    const editor = $('doc-editor');
    const status = $('doc-save-status');
    const stats = $('doc-stats');
    const blockSelect = $('doc-block');
    const exportSelect = $('doc-export');

    let dirty = false;
    let saving = false;
    let timer = null;
    let loaded = false;

    $('doc-title').textContent = name;
    $('doc-toolbar').hidden = readOnly;
    $('doc-save').hidden = readOnly;
    editor.contentEditable = readOnly ? 'false' : 'true';
    editor.replaceChildren();
    for (const opt of exportSelect.querySelectorAll('[data-copy]')) opt.hidden = !saveCopy;
    exportSelect.querySelector('optgroup[data-copy-group]').hidden = !saveCopy;

    const bannerEl = $('doc-banner');
    bannerEl.hidden = !banner;
    if (banner) {
      $('doc-banner-text').textContent = banner.text;
      const btn = $('doc-banner-action');
      btn.hidden = !banner.actionLabel;
      btn.textContent = banner.actionLabel || '';
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await banner.onAction();
        } finally {
          btn.disabled = false;
        }
      };
    }

    function updateStats() {
      stats.textContent = wordCount(editor.innerText || '');
    }

    function markDirty() {
      if (readOnly || !loaded) return;
      dirty = true;
      status.textContent = 'Unsaved changes';
      clearTimeout(timer);
      timer = setTimeout(() => save(true), 2000);
      updateStats();
    }

    async function save(silent = false) {
      if (readOnly || saving || !loaded) return;
      clearTimeout(timer);
      saving = true;
      status.textContent = 'Saving…';
      try {
        await saveHtml(I().sanitizeHtml(editor.innerHTML));
        dirty = false;
        status.textContent = 'All changes saved';
        if (onSaved) onSaved();
      } catch (err) {
        status.textContent = 'Save failed';
        if (!silent) toast(err.message || 'Could not save the document.');
      } finally {
        saving = false;
      }
    }

    // ---------- formatting ----------

    const exec = (cmd, value = null) => {
      editor.focus();
      document.execCommand(cmd, false, value);
      syncToolbar();
      markDirty();
    };

    function syncToolbar() {
      if (readOnly) return;
      for (const [id, cmd] of [['doc-bold', 'bold'], ['doc-italic', 'italic'], ['doc-underline', 'underline'], ['doc-strike', 'strikeThrough'], ['doc-ul', 'insertUnorderedList'], ['doc-ol', 'insertOrderedList']]) {
        let on = false;
        try {
          on = document.queryCommandState(cmd);
        } catch {}
        $(id).classList.toggle('active', on);
      }
      let block = '';
      try {
        block = String(document.queryCommandValue('formatBlock') || '').toLowerCase().replace(/[<>]/g, '');
      } catch {}
      blockSelect.value = ['h1', 'h2', 'h3', 'blockquote', 'pre'].includes(block) ? block : 'p';
    }

    const on = (id, fn) => ($(id).onclick = fn);
    on('doc-undo', () => exec('undo'));
    on('doc-redo', () => exec('redo'));
    on('doc-bold', () => exec('bold'));
    on('doc-italic', () => exec('italic'));
    on('doc-underline', () => exec('underline'));
    on('doc-strike', () => exec('strikeThrough'));
    on('doc-ul', () => exec('insertUnorderedList'));
    on('doc-ol', () => exec('insertOrderedList'));
    on('doc-align-left', () => exec('justifyLeft'));
    on('doc-align-center', () => exec('justifyCenter'));
    on('doc-align-right', () => exec('justifyRight'));
    on('doc-indent', () => exec('indent'));
    on('doc-outdent', () => exec('outdent'));
    on('doc-hr', () => exec('insertHorizontalRule'));
    on('doc-clear', () => {
      exec('removeFormat');
      exec('formatBlock', 'p');
    });
    on('doc-link', async () => {
      const sel = window.getSelection();
      const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      const url = window.rdriveAsk ? await window.rdriveAsk('Link address', 'https://', 'Add link') : prompt('Link address', 'https://');
      if (!url) return;
      if (!/^(https?:\/\/|mailto:)/i.test(url)) return toast('Links must start with https://, http:// or mailto:');
      editor.focus();
      if (range) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
      if (range && range.collapsed) exec('insertHTML', `<a href="${url.replace(/"/g, '&quot;')}">${url.replace(/</g, '&lt;')}</a>`);
      else exec('createLink', url);
    });
    on('doc-table', () => {
      const row = (cell) => `<tr>${cell.repeat(3)}</tr>`;
      exec('insertHTML', `<table><thead>${row('<th><br></th>')}</thead><tbody>${row('<td><br></td>')}${row('<td><br></td>')}</tbody></table><p><br></p>`);
    });
    const imageInput = $('doc-image-input');
    on('doc-image', () => imageInput.click());
    imageInput.onchange = () => {
      const file = imageInput.files[0];
      imageInput.value = '';
      if (!file) return;
      if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return toast('Choose a PNG, JPEG, GIF or WebP picture.');
      if (file.size > 5 * 1024 * 1024) return toast('Pictures up to 5 MB can be added to a document.');
      const reader = new FileReader();
      reader.onload = () => exec('insertHTML', `<img src="${reader.result}" alt="">`);
      reader.readAsDataURL(file);
    };
    blockSelect.onchange = () => exec('formatBlock', blockSelect.value);

    // ---------- export ----------

    exportSelect.value = '';
    exportSelect.onchange = async () => {
      const choice = exportSelect.value;
      exportSelect.value = '';
      if (!choice) return;
      if (choice === 'pdf') return printDoc();
      const [mode, kind] = choice.split(':');
      const fileName = `${baseName(name)}.${kind}`;
      status.textContent = `Preparing ${EXPORTS[kind].label} file…`;
      try {
        const blob = await exportBlob(kind, name, editor.innerHTML);
        if (mode === 'dl') {
          downloadBlob(blob, fileName);
          status.textContent = `Downloaded ${fileName}`;
        } else {
          const saved = await saveCopy(fileName, blob);
          status.textContent = `Saved a copy: ${saved}`;
          toast(`Saved "${saved}" in this folder.`);
        }
      } catch (err) {
        status.textContent = 'Export failed';
        toast(err.message || 'Could not export the document.');
      }
    };

    function printDoc() {
      document.body.classList.add('printing-doc');
      const done = () => {
        document.body.classList.remove('printing-doc');
        window.removeEventListener('afterprint', done);
      };
      window.addEventListener('afterprint', done);
      window.print();
      setTimeout(done, 1000);
    }

    // ---------- events ----------

    const onInput = () => markDirty();
    const onPaste = (e) => {
      if (readOnly) return;
      const html = e.clipboardData.getData('text/html');
      const text = e.clipboardData.getData('text/plain');
      e.preventDefault();
      if (html) document.execCommand('insertHTML', false, I().sanitizeHtml(html));
      else document.execCommand('insertText', false, text);
      markDirty();
    };
    const onDrop = (e) => {
      // Dropped files would otherwise be opened by the browser or uploaded by the drive page.
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onKey = (e) => {
      if (!dlg.open) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save(false);
      } else if (mod && e.key.toLowerCase() === 'k' && !readOnly) {
        e.preventDefault();
        $('doc-link').click();
      } else if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        printDoc();
      }
    };
    const onSelection = () => {
      if (dlg.open && editor.contains(document.activeElement)) syncToolbar();
    };
    // Links inside the page open in a new tab instead of navigating the drive away.
    const onClick = (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (!a || (!readOnly && !(e.ctrlKey || e.metaKey))) return;
      e.preventDefault();
      window.open(a.href, '_blank', 'noopener');
    };

    editor.addEventListener('input', onInput);
    editor.addEventListener('paste', onPaste);
    editor.addEventListener('drop', onDrop);
    editor.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    document.addEventListener('selectionchange', onSelection);

    on('doc-save', () => save(false));
    on('doc-close', async () => {
      if (dirty) await save(true);
      dlg.close();
    });
    dlg.addEventListener(
      'close',
      () => {
        clearTimeout(timer);
        editor.removeEventListener('input', onInput);
        editor.removeEventListener('paste', onPaste);
        editor.removeEventListener('drop', onDrop);
        editor.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('selectionchange', onSelection);
        editor.replaceChildren();
      },
      { once: true }
    );
    dlg.addEventListener('cancel', (e) => {
      // Esc: save first instead of silently dropping the last edits.
      if (dirty) {
        e.preventDefault();
        save(true).then(() => dlg.close());
      }
    });

    // ---------- load ----------

    status.textContent = 'Loading…';
    stats.textContent = '';
    if (!dlg.open) dlg.showModal();
    try {
      document.execCommand('defaultParagraphSeparator', false, 'p');
    } catch {}
    Promise.resolve()
      .then(loadHtml)
      .then((html) => {
        editor.innerHTML = I().sanitizeHtml(html || '');
        loaded = true;
        // Don't carry over a selection from the double-click that opened the file.
        const sel = window.getSelection();
        if (sel) sel.removeAllRanges();
        status.textContent = readOnly ? 'View only' : 'All changes saved';
        updateStats();
        if (!readOnly) {
          editor.focus();
          syncToolbar();
        }
      })
      .catch((err) => {
        status.textContent = 'Failed to load';
        toast(err.message || 'Could not open the document.');
      });
  }

  const api = { openDocModal, exportBlob, downloadBlob };
  if (typeof window !== 'undefined') window.RDriveDocs = api;
})();
