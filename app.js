(() => {
  const SAMPLE_DOC = `# My AI Prompt

<prompt>
  <context>
    <project_name>
      My Amazing Project
    </project_name>
    <goal>
      Describe your project goal here. What are you building?
    </goal>
  </context>

  <instructions>
    <rule>Always provide step-by-step reasoning.</rule>
    <rule>Ask for clarification when requirements are unclear.</rule>
    <rule>Never speculate beyond the provided context.</rule>
  </instructions>

  <response_format>
    Please respond in a structured, clear manner.
  </response_format>
</prompt>`;

  const APP_VERSION = 'v1.1.0';
  const HEARTBEAT_INTERVAL_MS = 5000;
  const HISTORY_LIMIT = 100;
  const TYPING_COMMIT_DELAY_MS = 800;
  let idCounter = 0;
  const XML_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
  const nativeHost = {
    isAvailable() {
      return !!window.pywebview?.api;
    },
    invoke(method, ...args) {
      if (!this.isAvailable() || typeof window.pywebview.api[method] !== 'function') {
        return Promise.resolve(null);
      }
      return window.pywebview.api[method](...args);
    },
    getAppInfo() {
      return this.invoke('get_app_info');
    },
    setDirty(dirty) {
      return this.invoke('set_dirty', dirty);
    },
    confirmDiscardChanges() {
      return this.invoke('confirm_discard_changes');
    },
    openFile() {
      return this.invoke('open_file');
    },
    saveFile(payload) {
      return this.invoke('save_file', payload);
    },
    writeClipboard(content) {
      return this.invoke('write_clipboard', content);
    },
  };
  window.nativeHost = nativeHost;

  const state = {
    doc: null,
    showExport: false,
    exportMode: 'ai',
    copied: false,
    showRaw: false,
    preambleEditing: false,
    preambleVal: '',
    showHelp: false,
    showAbout: false,
    openMenu: null,
    collapsed: {},
    dragNodeId: null,
    dragLatchedIndicator: null,
    historyPast: [],
    historyFuture: [],
    pendingHistory: null,
    rawText: '',
    lastSavedRawText: '',
    rawIssues: [],
    rawEditorView: null,
    fileInputEl: null,
  };

  function generateId() {
    idCounter += 1;
    return `node_${idCounter}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function isValidXmlName(name) {
    return XML_NAME_RE.test(String(name || ''));
  }

  function decodeXmlEntities(text) {
    return String(text || '').replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity) => {
      if (entity === 'amp') return '&';
      if (entity === 'lt') return '<';
      if (entity === 'gt') return '>';
      if (entity === 'quot') return '"';
      if (entity === 'apos') return "'";
      if (!entity.startsWith('#')) return match;

      const isHex = entity[1]?.toLowerCase() === 'x';
      const digits = isHex ? entity.slice(2) : entity.slice(1);
      const codePoint = Number.parseInt(digits, isHex ? 16 : 10);
      if (!Number.isFinite(codePoint)) return match;

      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    });
  }

  function escapeXmlText(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function escapeXmlAttribute(value) {
    return escapeXmlText(value)
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function parseLooseAttributes(attrStr, { decodeValues = false } = {}) {
    const attrs = {};
    const regex = /([A-Za-z_][A-Za-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
    let m;
    while ((m = regex.exec(attrStr)) !== null) {
      const rawValue = m[2] ?? m[3] ?? '';
      attrs[m[1]] = decodeValues ? decodeXmlEntities(rawValue) : rawValue;
    }
    return attrs;
  }

  function parseAttributes(attrStr) {
    return parseLooseAttributes(attrStr, { decodeValues: true });
  }

  function splitDocumentInput(input) {
    const lines = String(input || '').split('\n');
    let preamble = '';
    let xmlStart = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('<') && !trimmed.startsWith('<!')) {
        xmlStart = i;
        break;
      }
      preamble += (preamble ? '\n' : '') + lines[i];
    }

    return {
      lines,
      preamble,
      xmlStart,
      xmlText: xmlStart === -1 ? '' : lines.slice(xmlStart).join('\n'),
    };
  }

  function buildLineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === '\n') starts.push(i + 1);
    }
    return starts;
  }

  function getLineNumberAt(lineStarts, index) {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (lineStarts[mid] <= index) low = mid + 1;
      else high = mid - 1;
    }
    return high + 1;
  }

  function analyzeRawDocument(input) {
    const source = String(input || '');
    const parts = splitDocumentInput(source);

    if (parts.xmlStart === -1) {
      return {
        isValid: true,
        doc: { preamble: source, root: [] },
        issues: [],
        preamble: source,
      };
    }

    const xmlText = parts.xmlText;
    const xmlBaseLine = parts.xmlStart + 1;
    const lineStarts = buildLineStarts(xmlText);
    const issues = [];
    const stack = [];
    const pendingExpectedClosers = [];

    function absoluteLine(index) {
      return xmlBaseLine + getLineNumberAt(lineStarts, index) - 1;
    }

    function addIssue(message, line, highlightNeedle = '') {
      const safeLine = Math.max(1, line || xmlBaseLine);
      issues.push({
        line: safeLine,
        message,
        highlightNeedle,
      });
    }

    function addUniqueIssue(message, line, highlightNeedle = '') {
      const safeLine = Math.max(1, line || xmlBaseLine);
      if (issues.some((issue) => issue.line === safeLine && issue.message === message)) return;
      addIssue(message, safeLine, highlightNeedle);
    }

    function escapeRegex(text) {
      return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function hasFutureCloser(tag, fromIndex) {
      const pattern = new RegExp(`<\\/\\s*${escapeRegex(tag)}\\s*>`);
      return pattern.test(xmlText.slice(fromIndex));
    }

    function queuePendingExpectedCloser(tag, blockedByTag, blockedByLine) {
      pendingExpectedClosers.push({ tag, blockedByTag, blockedByLine });
    }

    function consumePendingExpectedCloser(tag) {
      const index = pendingExpectedClosers.findIndex((entry) => entry.tag === tag);
      if (index === -1) return false;
      return pendingExpectedClosers.splice(index, 1)[0];
    }

    let i = 0;
    while (i < xmlText.length) {
      if (xmlText[i] !== '<') {
        i += 1;
        continue;
      }

      const start = i;
      const end = xmlText.indexOf('>', i);
      if (end === -1) {
        addIssue('Unterminated tag fragment.', absoluteLine(start), '<');
        break;
      }

      const tagContent = xmlText.slice(i + 1, end);
      if (tagContent.startsWith('!--')) {
        const commentEnd = xmlText.indexOf('-->', i);
        if (commentEnd === -1) {
          addIssue('Unterminated comment.', absoluteLine(start), '<!--');
          break;
        }
        i = commentEnd + 3;
        continue;
      }

      if (tagContent.startsWith('!') || tagContent.startsWith('?')) {
        i = end + 1;
        continue;
      }

      if (tagContent.startsWith('/')) {
        const tag = tagContent.slice(1).trim();
        const line = absoluteLine(start);
        if (!tag) {
          addUniqueIssue('Empty closing tag.', line, '</');
        } else if (!isValidXmlName(tag)) {
          addUniqueIssue(`Invalid closing tag </${tag}>.`, line, `</${tag}>`);
        } else {
          const pendingExpectedCloser = consumePendingExpectedCloser(tag);
          if (pendingExpectedCloser) {
            addUniqueIssue(
              `Expected </${tag}> before line ${pendingExpectedCloser.blockedByLine} </${pendingExpectedCloser.blockedByTag}>.`,
              line,
              `</${tag}>`
            );
            i = end + 1;
            continue;
          }
        }

        if (!tag || !isValidXmlName(tag)) {
          i = end + 1;
          continue;
        }

        if (stack.length === 0) {
          addUniqueIssue(`Unexpected closing tag </${tag}>.`, line, `</${tag}>`);
        } else if (stack[stack.length - 1].tag === tag) {
          stack.pop();
        } else {
          let matchIndex = -1;
          for (let j = stack.length - 1; j >= 0; j -= 1) {
            if (stack[j].tag === tag) {
              matchIndex = j;
              break;
            }
          }
          if (matchIndex !== -1) {
            for (let j = stack.length - 1; j > matchIndex; j -= 1) {
              const skippedNode = stack[j];
              if (hasFutureCloser(skippedNode.tag, end + 1)) {
                queuePendingExpectedCloser(skippedNode.tag, tag, line);
              } else {
                addUniqueIssue(`Missing </${skippedNode.tag}>.`, skippedNode.line, `<${skippedNode.tag}`);
              }
            }
            stack.length = matchIndex;
          } else {
            addUniqueIssue(`Unexpected closing tag </${tag}>.`, line, `</${tag}>`);
          }
        }
        i = end + 1;
        continue;
      }

      const selfClosing = tagContent.endsWith('/');
      const inner = selfClosing ? tagContent.slice(0, -1).trim() : tagContent;
      const spaceIdx = inner.search(/\s/);
      const tag = (spaceIdx === -1 ? inner : inner.slice(0, spaceIdx)).trim();
      const line = absoluteLine(start);

      if (!tag) {
        addUniqueIssue(selfClosing ? 'Empty self-closing tag.' : 'Empty opening tag.', line, '<');
      } else if (!isValidXmlName(tag)) {
        addUniqueIssue(`Invalid tag name <${tag}>.`, line, `<${tag}`);
      } else if (!selfClosing) {
        stack.push({ tag, line });
      }

      i = end + 1;
    }

    for (let j = stack.length - 1; j >= 0; j -= 1) {
      const node = stack[j];
      addUniqueIssue(`Missing </${node.tag}>.`, node.line, `<${node.tag}`);
    }

    if (issues.length > 0) {
      return {
        isValid: false,
        doc: null,
        issues,
        preamble: parts.preamble,
      };
    }

    return {
      isValid: true,
      doc: parseDocument(source),
      issues: [],
      preamble: parts.preamble,
    };
  }

  function tokenize(xml) {
    const tokens = [];
    let i = 0;
    while (i < xml.length) {
      if (xml[i] === '<') {
        const end = xml.indexOf('>', i);
        if (end === -1) {
          tokens.push({ type: 'text', text: xml.slice(i) });
          break;
        }
        const tagContent = xml.slice(i + 1, end);

        if (tagContent.startsWith('!--')) {
          const commentEnd = xml.indexOf('-->', i);
          if (commentEnd === -1) {
            i = xml.length;
          } else {
            i = commentEnd + 3;
          }
          continue;
        }

        if (tagContent.startsWith('/')) {
          tokens.push({ type: 'close', tag: tagContent.slice(1).trim() });
          i = end + 1;
        } else if (tagContent.endsWith('/')) {
          const inner = tagContent.slice(0, -1).trim();
          const spaceIdx = inner.search(/\s/);
          const tag = spaceIdx === -1 ? inner : inner.slice(0, spaceIdx);
          const attrStr = spaceIdx === -1 ? '' : inner.slice(spaceIdx);
          tokens.push({ type: 'selfclose', tag, attributes: parseAttributes(attrStr) });
          i = end + 1;
        } else {
          const spaceIdx = tagContent.search(/\s/);
          const tag = spaceIdx === -1 ? tagContent : tagContent.slice(0, spaceIdx);
          const attrStr = spaceIdx === -1 ? '' : tagContent.slice(spaceIdx);
          tokens.push({ type: 'open', tag, attributes: parseAttributes(attrStr) });
          i = end + 1;
        }
      } else {
        const nextTag = xml.indexOf('<', i);
        const text = nextTag === -1 ? xml.slice(i) : xml.slice(i, nextTag);
        if (text.trim()) tokens.push({ type: 'text', text });
        i = nextTag === -1 ? xml.length : nextTag;
      }
    }
    return tokens;
  }

  function buildTree(tokens) {
    const stack = [];
    const roots = [];
    for (const token of tokens) {
      if (token.type === 'open') {
        const node = {
          id: generateId(),
          type: 'element',
          tag: token.tag,
          attributes: token.attributes || {},
          children: [],
        };
        if (stack.length > 0) {
          node.parent = stack[stack.length - 1].id;
          stack[stack.length - 1].children.push(node);
        } else {
          roots.push(node);
        }
        stack.push(node);
      } else if (token.type === 'close') {
        if (stack.length > 0) stack.pop();
      } else if (token.type === 'selfclose') {
        const node = {
          id: generateId(),
          type: 'element',
          tag: token.tag,
          attributes: token.attributes || {},
          children: [],
        };
        if (stack.length > 0) {
          node.parent = stack[stack.length - 1].id;
          stack[stack.length - 1].children.push(node);
        } else {
          roots.push(node);
        }
      } else if (token.type === 'text') {
        const textNode = {
          id: generateId(),
          type: 'text',
          text: decodeXmlEntities(token.text.trim()),
          children: [],
        };
        if (stack.length > 0) {
          textNode.parent = stack[stack.length - 1].id;
          stack[stack.length - 1].children.push(textNode);
        } else {
          roots.push(textNode);
        }
      }
    }
    return roots;
  }

  function parseDocument(input) {
    const { preamble, xmlStart, xmlText } = splitDocumentInput(input);
    if (xmlStart === -1) {
      return { preamble: input, root: [] };
    }
    return { preamble, root: buildTree(tokenize(xmlText)) };
  }

  function serializeToXml(nodes, indent = 0) {
    const pad = '  '.repeat(indent);
    let result = '';
    for (const node of nodes) {
      if (node.type === 'text') {
        const text = escapeXmlText((node.text || '').trim());
        if (text) result += `${pad}${text}\n`;
      } else {
        const attrs = node.attributes
          ? Object.entries(node.attributes).map(([k, v]) => ` ${k}="${escapeXmlAttribute(v)}"`).join('')
          : '';
        if (node.children.length === 0) {
          result += `${pad}<${node.tag}${attrs} />\n`;
        } else {
          const hasOnlyText = node.children.length === 1 && node.children[0].type === 'text';
          if (hasOnlyText) {
            const text = escapeXmlText((node.children[0].text || '').trim());
            result += `${pad}<${node.tag}${attrs}>${text}</${node.tag}>\n`;
          } else {
            result += `${pad}<${node.tag}${attrs}>\n`;
            result += serializeToXml(node.children, indent + 1);
            result += `${pad}</${node.tag}>\n`;
          }
        }
      }
    }
    return result;
  }

  function serializeFlatXml(nodes) {
    let result = '';
    for (const node of nodes) {
      if (node.type === 'text') {
        const text = escapeXmlText((node.text || '').trim());
        if (text) result += `${text}\n`;
      } else {
        const attrs = node.attributes
          ? Object.entries(node.attributes)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => ` ${k}="${escapeXmlAttribute(v)}"`).join('')
          : '';
        if (node.children.length === 0) {
          result += `<${node.tag}${attrs} />\n`;
        } else {
          result += `<${node.tag}${attrs}>\n`;
          result += serializeFlatXml(node.children);
          result += `</${node.tag}>\n`;
        }
      }
    }
    return result;
  }

  function serializeDocument(doc) {
    let result = '';
    if (doc.preamble) result += `${doc.preamble}\n\n`;
    result += serializeToXml(doc.root, 0);
    return result.replace(/\n+$/, '');
  }

  function serializeDocumentFlat(doc) {
    return serializeFlatXml(doc.root).replace(/\n+$/, '');
  }

  function serializeDocumentForAI(doc) {
    return serializeDocumentFlat(doc);
  }

  function removeNodeById(nodes, id) {
    return nodes.filter((n) => n.id !== id).map((n) => ({ ...n, children: removeNodeById(n.children, id) }));
  }

  function updateNodeById(nodes, id, updater) {
    return nodes.map((n) => {
      if (n.id === id) return updater(n);
      return { ...n, children: updateNodeById(n.children, id, updater) };
    });
  }

  function collectTextNodeValues(nodes, values = new Map()) {
    for (const node of nodes) {
      if (node.type === 'text') values.set(node.id, node.text || '');
      collectTextNodeValues(node.children, values);
    }
    return values;
  }

  function mergeTextNodeValues(nodes, values) {
    return nodes.map((node) => {
      const children = mergeTextNodeValues(node.children, values);
      if (node.type === 'text' && values.has(node.id)) {
        return { ...node, text: values.get(node.id), children };
      }
      return { ...node, children };
    });
  }

  function createElementNode(tag, parentId) {
    return {
      id: generateId(),
      type: 'element',
      tag,
      attributes: {},
      children: [createTextNode(undefined, '')],
      parent: parentId,
    };
  }

  function createTextNode(parentId, text = '') {
    return {
      id: generateId(),
      type: 'text',
      text,
      children: [],
      parent: parentId,
    };
  }

  function findNodeById(nodes, id) {
    for (const node of nodes) {
      if (node.id === id) return node;
      const found = findNodeById(node.children, id);
      if (found) return found;
    }
    return null;
  }

  function getNodeChildrenSiblings(nodes, nodeId) {
    function find(list, parentId) {
      for (const n of list) {
        if (n.id === nodeId) return { siblings: list, parentId };
        const found = find(n.children, n.id);
        if (found) return found;
      }
      return null;
    }
    return find(nodes, null) || { siblings: nodes, parentId: null };
  }

  function siblingElementTags(siblings, excludeId) {
    return new Set(
      siblings
        .filter((n) => n.type === 'element' && n.id !== excludeId && n.tag)
        .map((n) => n.tag)
    );
  }

  function uniqueTagName(base, usedNames) {
    if (!usedNames.has(base)) return base;
    let i = 2;
    while (usedNames.has(`${base}_${i}`)) i += 1;
    return `${base}_${i}`;
  }

  function isDescendant(node, maybeAncestorId) {
    if (!node || !maybeAncestorId) return false;
    if (node.id === maybeAncestorId) return true;
    return node.children.some((child) => isDescendant(child, maybeAncestorId));
  }

  function insertNodeAt(nodes, node, parentId, index) {
    if (parentId === null) {
      const arr = [...nodes];
      arr.splice(index, 0, node);
      return arr;
    }
    return nodes.map((n) => {
      if (n.id === parentId) {
        const children = [...n.children];
        children.splice(index, 0, { ...node, parent: parentId });
        return { ...n, children };
      }
      return { ...n, children: insertNodeAt(n.children, node, parentId, index) };
    });
  }

  function moveNode(nodes, nodeId, target) {
    const entry = findNodeById(nodes, nodeId);
    if (!entry) return nodes;
    const { siblings: sourceSiblings, parentId: sourceParentId } = getNodeChildrenSiblings(nodes, nodeId);
    const sourceIndex = sourceSiblings.findIndex((n) => n.id === nodeId);
    const targetParent = target.parentId ? findNodeById(nodes, target.parentId) : null;
    if (targetParent && isDescendant(entry, target.parentId)) return nodes;
    let targetIndex = target.index;
    if (sourceParentId === target.parentId && sourceIndex !== -1 && sourceIndex < targetIndex) {
      targetIndex -= 1;
    }
    const movedNode = JSON.parse(JSON.stringify(entry));
    movedNode.parent = target.parentId || undefined;
    let result = removeNodeById(nodes, nodeId);
    result = insertNodeAt(result, movedNode, target.parentId, targetIndex);
    return result;
  }

  function getDropTarget(nodes, draggedId, targetNode, clientX, clientY, rect) {
    if (!draggedId || draggedId === targetNode.id) return null;

    const draggedContext = getNodeChildrenSiblings(nodes, draggedId);
    const targetContext = getNodeChildrenSiblings(nodes, targetNode.id);
    const draggedNode = findNodeById(nodes, draggedId);
    const sameParent = draggedContext.parentId === targetContext.parentId;
    const relativeY = clientY - rect.top;
    const edgeBand = Math.min(Math.max(rect.height * 0.25, 18), 40);
    const leftBand = Math.min(Math.max(rect.width * 0.06, 20), 32);
    const relativeX = clientX - rect.left;

    if (draggedNode && draggedNode.parent && relativeX <= leftBand) {
      if (draggedContext.parentId === targetNode.id) {
        const targetIndex = targetContext.siblings.findIndex((n) => n.id === targetNode.id);
        if (targetIndex !== -1) {
          return {
            mode: 'after',
            parentId: targetContext.parentId,
            index: targetIndex + 1,
            indicatorNodeId: targetNode.id,
            outdent: true,
          };
        }
      }

      const targetChildIndex = targetNode.children.findIndex((child) => (
        child.id === draggedNode.parent || isDescendant(child, draggedNode.parent)
      ));
      if (targetChildIndex !== -1) {
        const anchorChild = targetNode.children[targetChildIndex];
        return {
          mode: 'after',
          parentId: targetNode.id,
          index: targetChildIndex + 1,
          indicatorNodeId: anchorChild?.id,
          outdent: true,
        };
      }
    }

    if (sameParent) {
      const targetIndex = targetContext.siblings.findIndex((n) => n.id === targetNode.id);
      if (targetIndex === -1) return null;

      if (relativeY <= edgeBand) {
        return {
          mode: 'before',
          parentId: targetContext.parentId,
          index: targetIndex,
        };
      }

      if (relativeY >= rect.height - edgeBand) {
        return {
          mode: 'after',
          parentId: targetContext.parentId,
          index: targetIndex + 1,
        };
      }

      return {
        mode: 'child',
        parentId: targetNode.id,
        index: targetNode.children.length,
      };
    }

    return {
      mode: 'child',
      parentId: targetNode.id,
      index: targetNode.children.length,
    };
  }

  function cloneDoc(doc) {
    return JSON.parse(JSON.stringify(doc));
  }

  function docsEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function getCurrentRawText() {
    if (state.preambleEditing && state.doc && !state.showRaw) {
      return serializeDocument({ ...state.doc, preamble: state.preambleVal });
    }
    return state.rawText ?? '';
  }

  function canUseVisualEditor() {
    return !!state.doc && state.rawIssues.length === 0;
  }

  function canExportCurrentDocument() {
    return canUseVisualEditor();
  }

  function snapshotRawEditorView(textarea) {
    return {
      scrollTop: textarea.scrollTop,
      scrollLeft: textarea.scrollLeft,
      selectionStart: textarea.selectionStart ?? 0,
      selectionEnd: textarea.selectionEnd ?? 0,
      wasFocused: document.activeElement === textarea,
    };
  }

  function createRawEditorLineJump(line) {
    return {
      targetLine: Math.max(1, line || 1),
      scrollTop: null,
      scrollLeft: 0,
      selectionStart: null,
      selectionEnd: null,
      wasFocused: false,
    };
  }

  function syncRawTextToCanonicalDoc() {
    if (!state.doc || state.rawIssues.length > 0) return;
    state.rawText = serializeDocument(state.doc);
  }

  function getCurrentDocSnapshot() {
    if (!state.doc) return null;
    const snapshot = cloneDoc(state.doc);
    if (state.preambleEditing) snapshot.preamble = state.preambleVal;
    return snapshot;
  }

  function hasUnsavedChanges() {
    return getCurrentRawText() !== state.lastSavedRawText;
  }

  function syncNativeDirtyState() {
    if (!nativeHost.isAvailable()) return;
    nativeHost.setDirty(hasUnsavedChanges()).catch(() => {});
  }

  function markCurrentStateAsSaved() {
    state.lastSavedRawText = getCurrentRawText();
    syncNativeDirtyState();
  }

  function collectElementIds(nodes, ids = new Set()) {
    for (const node of nodes) {
      if (node.type !== 'element') continue;
      ids.add(node.id);
      collectElementIds(node.children, ids);
    }
    return ids;
  }

  function buildInitialCollapsedState(doc) {
    const collapsed = {};

    function visit(nodes, depth) {
      for (const node of nodes) {
        if (node.type !== 'element') continue;
        if (depth > 0) collapsed[node.id] = true;
        visit(node.children, depth + 1);
      }
    }

    visit(doc.root, 0);
    return collapsed;
  }

  function syncCollapsedState(doc, source = state.collapsed) {
    const validIds = collectElementIds(doc.root);
    const next = {};

    for (const [id, isCollapsed] of Object.entries(source || {})) {
      if (validIds.has(id) && isCollapsed) next[id] = true;
    }

    return next;
  }

  function loadDocIntoState(doc, opts = {}) {
    const { syncRawText = true, rawTextOverride = null } = opts;
    state.doc = doc;
    state.preambleVal = doc.preamble;
    if (syncRawText) {
      const nextRawText = rawTextOverride ?? serializeDocument(doc);
      state.rawText = nextRawText;
      state.rawIssues = [];
    }
  }

  function loadInvalidRawState(rawText, issues, preamble = '') {
    commitPendingHistory();
    state.doc = { preamble, root: [] };
    state.preambleVal = preamble;
    state.rawText = rawText;
    state.rawIssues = issues;
    state.rawEditorView = issues.length > 0 ? createRawEditorLineJump(issues[0].line) : null;
    state.showRaw = true;
    state.showExport = false;
    state.copied = false;
    state.preambleEditing = false;
    render();
  }

  function pushHistorySnapshot(doc) {
    state.historyPast.push(cloneDoc(doc));
    if (state.historyPast.length > HISTORY_LIMIT) state.historyPast.shift();
  }

  function clearPendingHistoryTimer() {
    if (state.pendingHistory?.timerId) {
      window.clearTimeout(state.pendingHistory.timerId);
    }
  }

  function schedulePendingHistoryCommit() {
    if (!state.pendingHistory) return;
    clearPendingHistoryTimer();
    state.pendingHistory.timerId = window.setTimeout(() => {
      commitPendingHistory();
    }, TYPING_COMMIT_DELAY_MS);
  }

  function beginPendingHistorySession(key) {
    if (!state.doc) return;
    if (state.pendingHistory?.key === key) {
      schedulePendingHistoryCommit();
      return;
    }

    commitPendingHistory();
    state.pendingHistory = {
      key,
      snapshot: cloneDoc(state.doc),
      timerId: null,
    };
    schedulePendingHistoryCommit();
  }

  function commitPendingHistory() {
    if (!state.pendingHistory) return;
    clearPendingHistoryTimer();
    const { snapshot } = state.pendingHistory;
    state.pendingHistory = null;

    if (!state.doc || docsEqual(snapshot, state.doc)) return;
    pushHistorySnapshot(snapshot);
    state.historyFuture = [];
  }

  function setDoc(doc, opts = {}) {
    const { recordHistory = true, resetCollapsed = false, rawTextOverride = null } = opts;
    commitPendingHistory();
    const nextRawText = rawTextOverride ?? serializeDocument(doc);

    if (state.doc && docsEqual(state.doc, doc) && state.rawIssues.length === 0 && state.rawText === nextRawText) return;
    if (recordHistory && state.doc) {
      pushHistorySnapshot(state.doc);
      state.historyFuture = [];
    }

    loadDocIntoState(doc, { syncRawText: true, rawTextOverride: nextRawText });
    state.collapsed = resetCollapsed ? buildInitialCollapsedState(doc) : syncCollapsedState(doc, state.collapsed);
    render();
  }

  function updateRoot(root) {
    const nextRoot = state.doc ? mergeTextNodeValues(root, collectTextNodeValues(state.doc.root)) : root;
    setDoc({ ...state.doc, root: nextRoot });
  }

  function undo() {
    commitPendingHistory();
    if (state.historyPast.length === 0 || !state.doc) return;

    state.historyFuture.push(cloneDoc(state.doc));
    const previous = state.historyPast.pop();
    loadDocIntoState(previous);
    state.collapsed = syncCollapsedState(previous, state.collapsed);
    state.preambleEditing = false;
    render();
  }

  function redo() {
    commitPendingHistory();
    if (state.historyFuture.length === 0 || !state.doc) return;

    pushHistorySnapshot(state.doc);
    const next = state.historyFuture.pop();
    loadDocIntoState(next);
    state.collapsed = syncCollapsedState(next, state.collapsed);
    state.preambleEditing = false;
    render();
  }

  function applyRawText(text, { markSaved = false } = {}) {
    state.rawText = text;
    const analysis = analyzeRawDocument(text);
    if (analysis.isValid) {
      setDoc(analysis.doc, {
        resetCollapsed: true,
        rawTextOverride: text,
      });
      state.rawIssues = [];
      if (markSaved) markCurrentStateAsSaved();
      return true;
    }

    loadInvalidRawState(text, analysis.issues, analysis.preamble);
    if (markSaved) markCurrentStateAsSaved();
    return false;
  }

  function syncRawDraftState(text) {
    const analysis = analyzeRawDocument(text);
    state.rawText = text;
    state.rawIssues = analysis.issues;

    if (analysis.isValid) {
      state.doc = analysis.doc;
      state.preambleVal = analysis.doc.preamble;
      state.collapsed = buildInitialCollapsedState(analysis.doc);
    } else if (!state.doc) {
      state.doc = { preamble: analysis.preamble, root: [] };
      state.preambleVal = analysis.preamble;
      state.collapsed = {};
    }

    return analysis;
  }

  function isEditableTarget(target) {
    return target instanceof HTMLElement
      && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  }

  function handleGlobalKeydown(event) {
    if (event.key === 'Escape' && state.showAbout) {
      event.preventDefault();
      state.showAbout = false;
      render();
      return;
    }

    if (event.key === 'F1' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      toggleHelpDocs();
      render();
      return;
    }

    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (isEditableTarget(event.target)) return;

    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault();
      redo();
    } else if (key === 'n' && !event.shiftKey) {
      event.preventDefault();
      createNewDocument();
      render();
    } else if (key === 'o' && !event.shiftKey) {
      event.preventDefault();
      openFilePicker();
    } else if (key === 's' && event.shiftKey) {
      event.preventDefault();
      openSaveAsDialog();
      render();
    } else if (key === 'e' && !event.shiftKey) {
      event.preventDefault();
      activateVisualMode();
      render();
    } else if (key === 'r' && !event.shiftKey) {
      event.preventDefault();
      activateRawMode();
      render();
    } else if (key === 'i' && !event.shiftKey) {
      event.preventDefault();
      openAboutDialog();
      render();
    }
  }

  function getExportContent() {
    const doc = getCurrentDocSnapshot() || state.doc;
    return state.exportMode === 'ai' ? serializeDocumentForAI(doc) : serializeDocument(doc);
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildRawHighlightHtml(text, issues, includeHighlights) {
    const lines = String(text || '').split('\n');
    const highlightsByLine = new Map();

    if (includeHighlights) {
      for (const issue of issues || []) {
        if (!issue.highlightNeedle) continue;
        const lineIndex = Math.max(0, issue.line - 1);
        const list = highlightsByLine.get(lineIndex) || [];
        list.push(issue.highlightNeedle);
        highlightsByLine.set(lineIndex, list);
      }
    }

    return lines.map((lineText, lineIndex) => {
      const needles = highlightsByLine.get(lineIndex) || [];
      if (needles.length === 0) return escapeHtml(lineText);

      const ranges = [];
      for (const needle of needles) {
        const start = lineText.indexOf(needle);
        if (start === -1) continue;
        ranges.push({ start, end: start + needle.length });
      }

      ranges.sort((a, b) => a.start - b.start || a.end - b.end);
      const filtered = [];
      for (const range of ranges) {
        const prev = filtered[filtered.length - 1];
        if (!prev || range.start >= prev.end) filtered.push(range);
      }

      if (filtered.length === 0) return escapeHtml(lineText);

      let cursor = 0;
      let html = '';
      for (const range of filtered) {
        html += escapeHtml(lineText.slice(cursor, range.start));
        html += `<span class="raw-highlight-error">${escapeHtml(lineText.slice(range.start, range.end))}</span>`;
        cursor = range.end;
      }
      html += escapeHtml(lineText.slice(cursor));
      return html;
    }).join('\n');
  }

  function createTagIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'tag-symbol');
    svg.setAttribute('aria-hidden', 'true');

    const tagPath = document.createElementNS(ns, 'path');
    tagPath.setAttribute('d', 'M2.5 5.5V2.5H5.5L13.5 10.5L10.5 13.5L2.5 5.5Z');
    tagPath.setAttribute('fill', 'none');
    tagPath.setAttribute('stroke', 'currentColor');
    tagPath.setAttribute('stroke-width', '1.5');
    tagPath.setAttribute('stroke-linejoin', 'round');

    const hole = document.createElementNS(ns, 'circle');
    hole.setAttribute('cx', '4.5');
    hole.setAttribute('cy', '4.5');
    hole.setAttribute('r', '0.9');
    hole.setAttribute('fill', 'currentColor');

    svg.append(tagPath, hole);
    return svg;
  }

  function createTrashIcon() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'delete-icon');
    svg.setAttribute('aria-hidden', 'true');

    const lid = document.createElementNS(ns, 'path');
    lid.setAttribute('d', 'M5.5 3.5H10.5');
    lid.setAttribute('fill', 'none');
    lid.setAttribute('stroke', 'currentColor');
    lid.setAttribute('stroke-width', '1.5');
    lid.setAttribute('stroke-linecap', 'round');

    const rim = document.createElementNS(ns, 'path');
    rim.setAttribute('d', 'M3 4.5H13');
    rim.setAttribute('fill', 'none');
    rim.setAttribute('stroke', 'currentColor');
    rim.setAttribute('stroke-width', '1.5');
    rim.setAttribute('stroke-linecap', 'round');

    const body = document.createElementNS(ns, 'path');
    body.setAttribute('d', 'M4.5 5.5L5.1 12.5C5.15 13.05 5.61 13.5 6.17 13.5H9.83C10.39 13.5 10.85 13.05 10.9 12.5L11.5 5.5');
    body.setAttribute('fill', 'none');
    body.setAttribute('stroke', 'currentColor');
    body.setAttribute('stroke-width', '1.5');
    body.setAttribute('stroke-linecap', 'round');
    body.setAttribute('stroke-linejoin', 'round');

    const leftLine = document.createElementNS(ns, 'path');
    leftLine.setAttribute('d', 'M6.5 7V11.5');
    leftLine.setAttribute('fill', 'none');
    leftLine.setAttribute('stroke', 'currentColor');
    leftLine.setAttribute('stroke-width', '1.5');
    leftLine.setAttribute('stroke-linecap', 'round');

    const rightLine = document.createElementNS(ns, 'path');
    rightLine.setAttribute('d', 'M9.5 7V11.5');
    rightLine.setAttribute('fill', 'none');
    rightLine.setAttribute('stroke', 'currentColor');
    rightLine.setAttribute('stroke-width', '1.5');
    rightLine.setAttribute('stroke-linecap', 'round');

    svg.append(lid, rim, body, leftLine, rightLine);
    return svg;
  }

  function createArrowIcon(direction) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'arrow-icon');
    svg.setAttribute('aria-hidden', 'true');

    const triangle = document.createElementNS(ns, 'path');
    const pathByDirection = {
      up: 'M8 4L12.5 11H3.5L8 4Z',
      down: 'M3.5 5L12.5 5L8 12Z',
      right: 'M5 3.5L12 8L5 12.5V3.5Z',
    };
    triangle.setAttribute('d', pathByDirection[direction] || pathByDirection.down);
    triangle.setAttribute('fill', 'currentColor');

    svg.appendChild(triangle);
    return svg;
  }

  function btn(label, opts = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = opts.className || 'btn';
    b.textContent = label;
    if (opts.title) b.title = opts.title;
    if (opts.onClick) b.addEventListener('click', opts.onClick);
    return b;
  }

  function closeMenus() {
    state.openMenu = null;
  }

  function clearAllDragIndicators() {
    document.querySelectorAll('.drag-over, .drag-over-before, .drag-over-after, .drag-over-child').forEach((el) => {
      el.classList.remove('drag-over', 'drag-over-before', 'drag-over-after', 'drag-over-child');
    });
  }

  function clearLatchedDragIndicator() {
    state.dragLatchedIndicator = null;
    clearAllDragIndicators();
  }

  function applyLatchedDragIndicator(target) {
    state.dragLatchedIndicator = target;
    clearAllDragIndicators();
    const indicatorEl = target?.indicatorNodeId
      ? document.querySelector(`[data-node-id="${target.indicatorNodeId}"]`)
      : null;
    if (!indicatorEl || !target?.mode) return;
    indicatorEl.classList.add('drag-over', `drag-over-${target.mode}`);
  }

  function handleGlobalPointerDown(event) {
    if (!state.openMenu) return;
    if (event.target.closest('.menu')) return;
    closeMenus();
    render();
  }

  function createNewDocument() {
    if (!window.confirm('Start a new document? Unsaved changes will be lost.')) return false;
    state.showRaw = false;
    state.preambleEditing = false;
    const nextRaw = '# New Prompt\n\n<prompt>\n  \n</prompt>';
    applyRawText(nextRaw);
    return true;
  }

  async function openFilePicker() {
    if (nativeHost.isAvailable()) {
      if (hasUnsavedChanges()) {
        const confirmed = await nativeHost.confirmDiscardChanges();
        if (!confirmed) return false;
      }

      const result = await nativeHost.openFile();
      if (!result?.ok) {
        if (result && !result.cancelled && result.error) window.alert(`Open failed: ${result.error}`);
        return false;
      }

      state.showRaw = false;
      state.preambleEditing = false;
      const isValid = applyRawText(String(result.content || ''), { markSaved: true });
      if (!isValid) state.showRaw = true;
      markCurrentStateAsSaved();
      render();
      return true;
    }

    if (!state.fileInputEl) return false;
    state.fileInputEl.click();
    return true;
  }

  function openSaveAsDialog() {
    if (!canExportCurrentDocument()) return false;
    state.showExport = true;
    state.copied = false;
    return true;
  }

  function activateVisualMode() {
    if (!state.showRaw || !canUseVisualEditor()) return false;
    syncRawTextToCanonicalDoc();
    state.rawEditorView = null;
    state.showRaw = false;
    return true;
  }

  function activateRawMode() {
    if (state.showRaw) return false;
    state.showRaw = true;
    return true;
  }

  function toggleHelpDocs() {
    state.showHelp = !state.showHelp;
    return true;
  }

  function openAboutDialog() {
    state.showAbout = true;
    return true;
  }

  function renderTagEditor(node, nodes, container) {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';
    wrap.style.gap = '4px';

    const input = document.createElement('input');
    input.className = 'inline-input';
    input.value = node.tag || '';
    wrap.appendChild(input);

    const errorLine = document.createElement('div');
    errorLine.className = 'error-line hidden';
    wrap.appendChild(errorLine);

    function isDuplicate(name) {
      const { siblings } = getNodeChildrenSiblings(nodes, node.id);
      return siblingElementTags(siblings, node.id).has(name);
    }

    function showError(message) {
      input.classList.add('error');
      errorLine.textContent = `⚠ ${message}`;
      errorLine.classList.remove('hidden');
      container.closest('.element-frame, .node-card')?.classList.add('error');
    }

    function clearError() {
      input.classList.remove('error');
      errorLine.classList.add('hidden');
      container.closest('.element-frame, .node-card')?.classList.remove('error');
    }

    function save() {
      const name = input.value.trim();
      if (!name) {
        render();
        return;
      }
      if (!isValidXmlName(name)) {
        showError('Use a valid XML name. Start with a letter or underscore, then use letters, numbers, ., -, _, or :.');
        return;
      }
      if (isDuplicate(name)) {
        showError(`"${name}" already exists among siblings.`);
        return;
      }
      clearError();
      updateRoot(updateNodeById(nodes, node.id, (n) => ({ ...n, tag: name })));
    }

    input.addEventListener('input', () => {
      const val = input.value.trim();
      if (!val) {
        clearError();
        return;
      }
      if (!isValidXmlName(val)) {
        showError('Use a valid XML name. Start with a letter or underscore, then use letters, numbers, ., -, _, or :.');
        return;
      }
      if (isDuplicate(val)) showError(`"${val}" already exists among siblings.`);
      else clearError();
    });
    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') render();
    });

    container.replaceChildren(wrap);
    input.focus();
    input.select();
  }

  function renderAttrEditor(node, nodes, container) {
    const input = document.createElement('input');
    input.className = 'attr-input';
    input.value = node.attributes
      ? Object.entries(node.attributes).map(([k, v]) => (v ? `${k}="${v}"` : k)).join(' ')
      : '';

    function save() {
      const attrs = parseLooseAttributes(input.value);
      updateRoot(updateNodeById(nodes, node.id, (n) => ({ ...n, attributes: attrs })));
    }

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') render();
    });

    container.replaceChildren(input);
    input.focus();
    input.select();
  }

  function renderTextNode(node, depth, nodes) {
    const row = document.createElement('div');
    row.className = `node-row node-indent-${Math.min(depth, 10)}`;

    const wrap = document.createElement('div');
    wrap.className = 'text-row';
    const parentNode = node.parent ? findNodeById(nodes, node.parent) : null;
    const canDeleteText = !!parentNode && parentNode.type === 'element' && parentNode.children.some((child) => child.type === 'element');

    const iconEl = document.createElement('div');
    iconEl.className = 'text-icon';
    iconEl.textContent = '▤';
    wrap.appendChild(iconEl);

    const textarea = document.createElement('textarea');
    textarea.className = 'text-node-textarea';
    textarea.placeholder = 'Text content...';
    textarea.value = (node.text || '').trim();
    textarea.rows = Math.max(1, textarea.value ? textarea.value.split('\n').length : 1);
    textarea.addEventListener('input', () => {
      beginPendingHistorySession(`text:${node.id}`);
      textarea.rows = Math.max(1, textarea.value ? textarea.value.split('\n').length : 1);
      state.doc.root = updateNodeById(state.doc.root, node.id, (n) => ({ ...n, text: textarea.value }));
      syncRawTextToCanonicalDoc();
    });
    textarea.addEventListener('blur', () => commitPendingHistory());
    wrap.appendChild(textarea);

    if (canDeleteText) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'action-btn red text-row-delete';
      deleteBtn.title = 'Remove text content';
      deleteBtn.appendChild(createTrashIcon());
      deleteBtn.addEventListener('click', () => updateRoot(removeNodeById(nodes, node.id)));
      wrap.appendChild(deleteBtn);
    }

    row.appendChild(wrap);
    return row;
  }

  function renderElementNode(node, depth, nodes) {
    const row = document.createElement('div');
    row.className = `node-row node-indent-${Math.min(depth, 10)}`;

    const frame = document.createElement('div');
    frame.className = 'element-frame';
    frame.dataset.nodeId = node.id;
    const clearDropClasses = () => frame.classList.remove('drag-over', 'drag-over-before', 'drag-over-after', 'drag-over-child');
    const applyDropClasses = (mode) => {
      clearDropClasses();
      if (!mode) return;
      frame.classList.add('drag-over', `drag-over-${mode}`);
    };

    const card = document.createElement('div');
    card.className = 'node-card element-frame-header';
    card.draggable = true;
    card.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input, textarea')) return;
      state.collapsed[node.id] = !state.collapsed[node.id];
      render();
    });
    let dragDepth = 0;
    card.addEventListener('dragstart', (e) => {
      state.dragNodeId = node.id;
      state.dragLatchedIndicator = null;
      clearAllDragIndicators();
      frame.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', node.id);
    });
    card.addEventListener('dragend', () => {
      state.dragNodeId = null;
      state.dragLatchedIndicator = null;
      dragDepth = 0;
      frame.classList.remove('dragging');
      clearAllDragIndicators();
    });

    frame.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (!state.dragNodeId || state.dragNodeId === node.id) return;
      dragDepth += 1;
      const target = getDropTarget(nodes, state.dragNodeId, node, e.clientX, e.clientY, frame.getBoundingClientRect());
      if (target?.outdent) {
        applyLatchedDragIndicator(target);
      } else {
        if (state.dragLatchedIndicator) state.dragLatchedIndicator = null;
        applyDropClasses(target?.mode);
      }
    });
    frame.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!state.dragNodeId || state.dragNodeId === node.id) return;
      const target = getDropTarget(nodes, state.dragNodeId, node, e.clientX, e.clientY, frame.getBoundingClientRect());
      if (target?.outdent) {
        applyLatchedDragIndicator(target);
      } else {
        if (state.dragLatchedIndicator) state.dragLatchedIndicator = null;
        applyDropClasses(target?.mode);
      }
    });
    frame.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0 && !state.dragLatchedIndicator) clearDropClasses();
    });
    frame.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.dragLatchedIndicator = null;
      dragDepth = 0;
      clearAllDragIndicators();
      const dragged = e.dataTransfer.getData('text/plain');
      const target = getDropTarget(nodes, dragged, node, e.clientX, e.clientY, frame.getBoundingClientRect());
      if (dragged && dragged !== node.id && target) {
        updateRoot(moveNode(nodes, dragged, { parentId: target.parentId, index: target.index }));
      }
    });

    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.textContent = '⋮⋮';
    card.appendChild(grip);

    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'expand-btn';
    const hasChildren = node.children.length > 0;
    expand.title = state.collapsed[node.id] ? 'Expand' : 'Collapse';
    if (hasChildren) {
      expand.appendChild(createArrowIcon(state.collapsed[node.id] ? 'right' : 'down'));
    }
    expand.addEventListener('click', () => {
      if (!hasChildren) return;
      state.collapsed[node.id] = !state.collapsed[node.id];
      render();
    });
    expand.disabled = !hasChildren;
    card.appendChild(expand);

    const main = document.createElement('div');
    main.className = 'node-main';

    main.appendChild(createTagIcon());

    const tagWrap = document.createElement('div');
    const tagBtn = document.createElement('button');
    tagBtn.type = 'button';
    tagBtn.className = 'tag-pill';
    tagBtn.textContent = `<${node.tag}>`;
    tagBtn.addEventListener('click', () => renderTagEditor(node, nodes, tagWrap));
    tagWrap.appendChild(tagBtn);
    main.appendChild(tagWrap);

    const attrWrap = document.createElement('div');
    const attrDisplay = node.attributes
      ? Object.entries(node.attributes)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => (v ? `${k}="${v}"` : k))
          .join(' ')
      : '';

    if (attrDisplay) {
      const attrBtn = document.createElement('button');
      attrBtn.type = 'button';
      attrBtn.className = 'attr-pill';
      attrBtn.textContent = attrDisplay;
      attrBtn.addEventListener('click', () => renderAttrEditor(node, nodes, attrWrap));
      attrWrap.appendChild(attrBtn);
    } else {
      const attrBtn = document.createElement('button');
      attrBtn.type = 'button';
      attrBtn.className = 'attr-pill attr-placeholder';
      attrBtn.textContent = '+ attr';
      attrBtn.addEventListener('click', () => renderAttrEditor(node, nodes, attrWrap));
      attrWrap.appendChild(attrBtn);
    }
    main.appendChild(attrWrap);
    card.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'node-actions';

    const moveUpBtn = document.createElement('button');
    moveUpBtn.type = 'button';
    moveUpBtn.className = 'action-btn';
    moveUpBtn.title = 'Move up';
    moveUpBtn.appendChild(createArrowIcon('up'));
    moveUpBtn.addEventListener('click', () => {
      const { siblings, parentId } = getNodeChildrenSiblings(nodes, node.id);
      const idx = siblings.findIndex((n) => n.id === node.id);
      if (idx <= 0) return;
      const arr = [...siblings];
      [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
      if (parentId === null) updateRoot(arr);
      else updateRoot(updateNodeById(nodes, parentId, (n) => ({ ...n, children: arr })));
    });
    actions.appendChild(moveUpBtn);

    const moveDownBtn = document.createElement('button');
    moveDownBtn.type = 'button';
    moveDownBtn.className = 'action-btn';
    moveDownBtn.title = 'Move down';
    moveDownBtn.appendChild(createArrowIcon('down'));
    moveDownBtn.addEventListener('click', () => {
      const { siblings, parentId } = getNodeChildrenSiblings(nodes, node.id);
      const idx = siblings.findIndex((n) => n.id === node.id);
      if (idx >= siblings.length - 1) return;
      const arr = [...siblings];
      [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
      if (parentId === null) updateRoot(arr);
      else updateRoot(updateNodeById(nodes, parentId, (n) => ({ ...n, children: arr })));
    });
    actions.appendChild(moveDownBtn);

    const addChildBtn = document.createElement('button');
    addChildBtn.type = 'button';
    addChildBtn.className = 'action-btn green';
    addChildBtn.title = 'Add child element';
    addChildBtn.textContent = '+';
    addChildBtn.addEventListener('click', () => {
      const existing = new Set(node.children.filter((c) => c.type === 'element').map((c) => c.tag));
      const name = uniqueTagName('new_tag', existing);
      const child = createElementNode(name, node.id);
      state.collapsed[node.id] = false;
      updateRoot(updateNodeById(nodes, node.id, (n) => ({ ...n, children: [...n.children, child] })));
    });
    actions.appendChild(addChildBtn);

    const addTextBtn = document.createElement('button');
    addTextBtn.type = 'button';
    addTextBtn.className = 'action-btn blue action-btn-text';
    addTextBtn.title = 'Add text content';
    addTextBtn.textContent = '+T';
    addTextBtn.addEventListener('click', () => {
      const hasDirectText = node.children.some((child) => child.type === 'text');
      if (hasDirectText) {
        state.collapsed[node.id] = false;
        render();
        return;
      }

      const textNode = createTextNode(node.id, '');
      state.collapsed[node.id] = false;
      updateRoot(updateNodeById(nodes, node.id, (n) => ({ ...n, children: [textNode, ...n.children] })));
    });
    actions.appendChild(addTextBtn);

    const addSiblingBtn = document.createElement('button');
    addSiblingBtn.type = 'button';
    addSiblingBtn.className = 'action-btn blue';
    addSiblingBtn.title = 'Add sibling after';
    addSiblingBtn.textContent = '+↓';
    addSiblingBtn.addEventListener('click', () => {
      const { siblings, parentId } = getNodeChildrenSiblings(nodes, node.id);
      const idx = siblings.findIndex((n) => n.id === node.id);
      const used = siblingElementTags(siblings, '');
      const name = uniqueTagName('new_tag', used);
      const newNode = createElementNode(name, parentId || undefined);
      const newSiblings = [...siblings];
      newSiblings.splice(idx + 1, 0, newNode);
      if (parentId === null) updateRoot(newSiblings);
      else updateRoot(updateNodeById(nodes, parentId, (n) => ({ ...n, children: newSiblings })));
    });
    actions.appendChild(addSiblingBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'action-btn red';
    deleteBtn.title = 'Delete';
    deleteBtn.appendChild(createTrashIcon());
    deleteBtn.addEventListener('click', () => updateRoot(removeNodeById(nodes, node.id)));
    actions.appendChild(deleteBtn);

    card.appendChild(actions);
    frame.appendChild(card);

    const isCollapsed = !!state.collapsed[node.id];
    if (!isCollapsed) {
      if (hasChildren) {
        const childrenWrap = document.createElement('div');
        childrenWrap.className = 'children-wrap element-frame-children';
        for (const child of node.children) {
          childrenWrap.appendChild(renderNode(child, 0, nodes));
        }
        frame.appendChild(childrenWrap);
      }

      const closing = document.createElement('div');
      closing.className = 'node-card element-frame-footer';
      const spacer = document.createElement('div');
      spacer.style.width = '70px';
      spacer.style.flex = '0 0 auto';
      closing.appendChild(spacer);
      const main2 = document.createElement('div');
      main2.className = 'node-main';
      main2.appendChild(createTagIcon());
      const closingTag = document.createElement('span');
      closingTag.className = 'tag-pill-closing';
      closingTag.textContent = `</${node.tag}>`;
      main2.appendChild(closingTag);
      closing.appendChild(main2);
      frame.appendChild(closing);
    }

    row.appendChild(frame);
    return row;
  }

  function renderNode(node, depth, nodes) {
    if (node.type === 'text') return renderTextNode(node, depth, nodes);
    return renderElementNode(node, depth, nodes);
  }

  async function downloadText(filename, content) {
    if (nativeHost.isAvailable()) {
      const result = await nativeHost.saveFile({
        suggestedName: filename,
        content,
      });
      if (!result?.ok) {
        if (result && !result.cancelled && result.error) window.alert(`Save failed: ${result.error}`);
        return false;
      }
      return true;
    }

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  function renderHeader(root) {
    const topbar = document.createElement('header');
    topbar.className = 'topbar';
    const inner = document.createElement('div');
    inner.className = 'topbar-inner';

    const left = document.createElement('div');
    left.className = 'topbar-left';

    const iconBox = document.createElement('div');
    iconBox.className = 'brand-icon';
    iconBox.textContent = '</>';
    left.appendChild(iconBox);

    const openBtn = btn('Open File', { className: 'btn hidden' });
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.txt,.xml';
    input.className = 'hidden';
    state.fileInputEl = input;
    input.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = String(ev.target?.result || '');
        state.showRaw = false;
        state.preambleEditing = false;
        const isValid = applyRawText(text, { markSaved: true });
        if (!isValid) state.showRaw = true;
        markCurrentStateAsSaved();
      };
      reader.readAsText(file);
      input.value = '';
    });
    openBtn.addEventListener('click', () => input.click());
    left.appendChild(openBtn);
    left.appendChild(input);

    const menuBar = document.createElement('div');
    menuBar.className = 'menu-bar';

    const menuConfigs = [
      {
        key: 'file',
        label: 'File',
        items: [
          {
            label: 'New',
            shortcut: 'Ctrl+N',
            action: () => createNewDocument(),
          },
          {
            label: 'Open',
            shortcut: 'Ctrl+O',
            action: () => openFilePicker(),
          },
          {
            label: 'Save as...',
            shortcut: 'Ctrl+Shift+S',
            disabled: !canExportCurrentDocument(),
            title: !canExportCurrentDocument() ? 'Fix raw errors before saving.' : undefined,
            action: () => openSaveAsDialog(),
          },
        ],
      },
      {
        key: 'edit',
        label: 'Edit',
        items: [
          {
            label: 'Visual',
            shortcut: 'Ctrl+E',
            disabled: !state.showRaw || !canUseVisualEditor(),
            title: !canUseVisualEditor() ? 'Fix raw errors to re-enable Visual.' : undefined,
            action: () => activateVisualMode(),
          },
          {
            label: 'Raw',
            shortcut: 'Ctrl+R',
            disabled: state.showRaw,
            action: () => activateRawMode(),
          },
        ],
      },
      {
        key: 'help',
        label: 'Help',
        items: [
          {
            label: 'Doc',
            shortcut: 'F1',
            action: () => toggleHelpDocs(),
          },
          {
            label: 'About',
            shortcut: 'Ctrl+I',
            action: () => openAboutDialog(),
          },
        ],
      },
    ];

    for (const menuConfig of menuConfigs) {
      const menu = document.createElement('div');
      menu.className = `menu menu-${menuConfig.key}`;

      const menuBtn = document.createElement('button');
      menuBtn.type = 'button';
      menuBtn.className = `menu-btn ${state.openMenu === menuConfig.key ? 'menu-btn-open' : ''}`;
      menuBtn.textContent = menuConfig.label;
      menuBtn.addEventListener('click', () => {
        state.openMenu = state.openMenu === menuConfig.key ? null : menuConfig.key;
        render();
      });
      menu.appendChild(menuBtn);

      if (state.openMenu === menuConfig.key) {
        const dropdown = document.createElement('div');
        dropdown.className = 'menu-dropdown';
        for (const item of menuConfig.items) {
          const itemBtn = document.createElement('button');
          itemBtn.type = 'button';
          itemBtn.className = 'menu-item';
          itemBtn.disabled = !!item.disabled;
          if (item.title) itemBtn.title = item.title;

          const label = document.createElement('span');
          label.className = 'menu-item-label';
          label.textContent = item.label;
          itemBtn.appendChild(label);

          if (item.shortcut) {
            const shortcut = document.createElement('span');
            shortcut.className = 'menu-shortcut';
            shortcut.textContent = item.shortcut;
            itemBtn.appendChild(shortcut);
          }

          itemBtn.addEventListener('click', () => {
            if (item.disabled) return;
            closeMenus();
            item.action();
            render();
          });
          dropdown.appendChild(itemBtn);
        }
        menu.appendChild(dropdown);
      }

      menuBar.appendChild(menu);
    }

    left.appendChild(menuBar);
    inner.appendChild(left);

    const centeredTitle = document.createElement('div');
    centeredTitle.className = 'topbar-title';
    centeredTitle.textContent = nativeHost.isAvailable() ? 'XML Editor Desktop' : 'XML Editor';
    inner.appendChild(centeredTitle);

    const right = document.createElement('div');
    right.className = 'topbar-right';
    inner.appendChild(right);

    topbar.appendChild(inner);
    root.appendChild(topbar);
  }

  function renderHelp(root) {
    if (!state.showHelp) return;
    const help = document.createElement('div');
    help.className = 'help-panel';
    const inner = document.createElement('div');
    inner.className = 'help-inner';
    const grid = document.createElement('div');
    grid.className = 'help-grid';
    const items = [
      ['Click tag name', 'rename it'],
      ['Click attr text', 'edit attributes'],
      ['Drag grip', 'move elements into another node'],
      ['▲▼ arrows', 'reorder siblings'],
      ['+ button', 'add child element'],
      ['+↓ button', 'add sibling below'],
      ['Trash icon', 'delete element'],
      ['Text area', 'edit text content'],
      ['Raw editor', 'fix malformed files and re-enable Visual'],
      ['Ctrl+Z / Ctrl+Y', 'undo or redo document changes'],
    ];
    for (const [strong, rest] of items) {
      const div = document.createElement('div');
      div.innerHTML = `<strong>${escapeHtml(strong)}</strong> — ${escapeHtml(rest)}`;
      grid.appendChild(div);
    }
    inner.appendChild(grid);
    help.appendChild(inner);
    root.appendChild(help);
  }

  function renderPreambleCard(container) {
    if (state.doc.preamble || state.preambleEditing) {
      const card = document.createElement('div');
      card.className = 'card';
      const header = document.createElement('div');
      header.className = 'card-header';
      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = 'PREAMBLE (TEXT BEFORE XML)';
      header.appendChild(title);
      card.appendChild(header);

      if (state.preambleEditing) {
        const body = document.createElement('div');
        body.className = 'card-body';
        const textarea = document.createElement('textarea');
        textarea.className = 'preamble-textarea';
        textarea.value = state.preambleVal;
        textarea.addEventListener('input', () => {
          state.preambleVal = textarea.value;
        });
        body.appendChild(textarea);
        const actions = document.createElement('div');
        actions.className = 'action-row';
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'mini-btn mini-btn-primary';
        save.textContent = 'Save';
        save.addEventListener('click', () => {
          state.preambleEditing = false;
          setDoc({ ...state.doc, preamble: state.preambleVal });
        });
        actions.appendChild(save);
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'mini-btn mini-btn-muted';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', () => {
          state.preambleVal = state.doc.preamble;
          state.preambleEditing = false;
          render();
        });
        actions.appendChild(cancel);
        body.appendChild(actions);
        card.appendChild(body);
      } else {
        const display = document.createElement('div');
        display.className = 'preamble-display';
        display.textContent = state.doc.preamble || 'No preamble';
        if (!state.doc.preamble) display.classList.add('muted-empty');
        display.addEventListener('click', () => {
          state.preambleEditing = true;
          render();
        });
        card.appendChild(display);
      }
      container.appendChild(card);
    } else {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'add-preamble';
      add.textContent = '+ Add preamble (e.g. Markdown title or comment)';
      add.addEventListener('click', () => {
        state.preambleEditing = true;
        render();
      });
      container.appendChild(add);
    }
  }

  function renderStructureCard(container) {
    const card = document.createElement('div');
    card.className = 'card';
    const header = document.createElement('div');
    header.className = 'card-header';
    const iconEl = document.createElement('span');
    iconEl.textContent = '</>';
    iconEl.style.color = '#94a3b8';
    iconEl.style.fontSize = '13px';
    header.appendChild(iconEl);
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = 'XML Structure';
    header.appendChild(title);
    const subtle = document.createElement('div');
    subtle.className = 'card-subtle';
    subtle.textContent = `${state.doc.root.length} root element${state.doc.root.length !== 1 ? 's' : ''}`;
    header.appendChild(subtle);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'structure-body';
    const list = document.createElement('div');
    list.className = 'node-list';
    for (const node of state.doc.root) {
      list.appendChild(renderNode(node, 0, state.doc.root));
    }
    body.appendChild(list);

    const addWrap = document.createElement('div');
    addWrap.className = 'add-root-wrap';
    const addRoot = document.createElement('button');
    addRoot.type = 'button';
    addRoot.className = 'add-root-btn';
    addRoot.textContent = '+ Add root element';
    addRoot.addEventListener('click', () => {
      const used = new Set(state.doc.root.filter((n) => n.type === 'element').map((n) => n.tag));
      const name = uniqueTagName('new_tag', used);
      updateRoot([...state.doc.root, createElementNode(name)]);
    });
    addWrap.appendChild(addRoot);
    body.appendChild(addWrap);
    card.appendChild(body);
    container.appendChild(card);
  }

  function renderRawCard(container) {
    const card = document.createElement('div');
    card.className = 'card';
    const header = document.createElement('div');
    header.className = 'card-header';
    const iconEl = document.createElement('span');
    iconEl.textContent = '📄';
    iconEl.style.fontSize = '13px';
    header.appendChild(iconEl);
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = 'Raw document editor';
    header.appendChild(title);
    const subtle = document.createElement('div');
    subtle.className = 'card-subtle';
    header.appendChild(subtle);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'card-body';

    const editorShell = document.createElement('div');
    editorShell.className = 'raw-editor-shell';

    const gutter = document.createElement('div');
    gutter.className = 'raw-line-gutter';

    const gutterLines = document.createElement('pre');
    gutterLines.className = 'raw-line-gutter-lines';
    gutter.appendChild(gutterLines);
    editorShell.appendChild(gutter);

    const editorPane = document.createElement('div');
    editorPane.className = 'raw-editor-pane';

    const highlightLayer = document.createElement('pre');
    highlightLayer.className = 'raw-highlight-layer';
    editorPane.appendChild(highlightLayer);

    const textarea = document.createElement('textarea');
    textarea.className = 'raw-editor';
    textarea.value = state.rawText;
    textarea.spellcheck = false;
    textarea.wrap = 'off';

    function updateSubtleText() {
      if (state.rawIssues.length > 0) {
        subtle.textContent = `${state.rawIssues.length} structural issue${state.rawIssues.length !== 1 ? 's' : ''} — fix here to re-enable Visual`;
      } else {
        subtle.textContent = 'Editable raw mode — Visual is unlocked while the structure remains valid';
      }
    }

    function syncEditorDecorations() {
      const showHighlightOverlay = state.rawIssues.length > 0;
      const lineCount = Math.max(1, textarea.value.split('\n').length);
      gutterLines.textContent = Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n');
      gutter.scrollTop = textarea.scrollTop;
      highlightLayer.classList.toggle('hidden', !showHighlightOverlay);
      textarea.classList.toggle('raw-editor-highlight-mode', showHighlightOverlay);
      if (showHighlightOverlay) {
        highlightLayer.scrollTop = textarea.scrollTop;
        highlightLayer.scrollLeft = textarea.scrollLeft;
        highlightLayer.innerHTML = buildRawHighlightHtml(
          textarea.value,
          state.rawIssues,
          true
        );
      } else {
        highlightLayer.scrollTop = 0;
        highlightLayer.scrollLeft = 0;
        highlightLayer.innerHTML = '';
      }
    }

    const status = document.createElement('div');

    const diagnostics = document.createElement('div');
    diagnostics.className = 'raw-diagnostics';

    const diagTitle = document.createElement('div');
    diagTitle.className = 'raw-diagnostics-title';
    diagTitle.textContent = 'Structural diagnostics';
    diagnostics.appendChild(diagTitle);

    const list = document.createElement('div');
    list.className = 'raw-issue-list';
    diagnostics.appendChild(list);

    function updateStatusText() {
      status.className = `raw-status ${state.rawIssues.length > 0 ? 'error' : 'success'}`;
      if (state.rawIssues.length > 0) {
        status.textContent = 'Visual is locked until the raw document becomes structurally valid.';
      } else {
        status.textContent = 'Raw text is structurally valid. Visual is unlocked.';
      }
    }

    function updateDiagnosticsList() {
      diagnostics.classList.toggle('hidden', state.rawIssues.length === 0);
      list.replaceChildren();
      for (const issue of state.rawIssues) {
        const item = document.createElement('div');
        item.className = 'raw-issue-item';

        const msg = document.createElement('div');
        msg.className = 'raw-issue-message';
        msg.textContent = `Line ${issue.line}: ${issue.message}`;
        item.appendChild(msg);

        list.appendChild(item);
      }
    }

    function updateRawDraftFeedback(preservedView = null) {
      const wasVisualAvailable = canUseVisualEditor();
      syncRawDraftState(textarea.value);
      updateSubtleText();
      updateStatusText();
      updateDiagnosticsList();
      syncEditorDecorations();
      const isVisualAvailable = canUseVisualEditor();
      if (wasVisualAvailable !== isVisualAvailable) {
        state.rawEditorView = preservedView;
        render();
        return;
      }
    }

    textarea.addEventListener('input', () => {
      state.rawText = textarea.value;
      const view = snapshotRawEditorView(textarea);
      updateRawDraftFeedback(view);
    });
    textarea.addEventListener('scroll', () => {
      gutter.scrollTop = textarea.scrollTop;
      if (state.rawIssues.length > 0) {
        highlightLayer.scrollTop = textarea.scrollTop;
        highlightLayer.scrollLeft = textarea.scrollLeft;
      }
    });
    editorPane.appendChild(textarea);
    editorShell.appendChild(editorPane);
    body.appendChild(editorShell);
    body.appendChild(status);
    body.appendChild(diagnostics);

    updateRawDraftFeedback();

    if (state.rawEditorView) {
      const view = state.rawEditorView;
      state.rawEditorView = null;
      requestAnimationFrame(() => {
        if (view.targetLine != null) {
          const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 21.45;
          const targetScrollTop = Math.max(0, (view.targetLine - 1) * lineHeight - lineHeight * 1.5);
          textarea.scrollTop = targetScrollTop;
          textarea.scrollLeft = 0;
          gutter.scrollTop = targetScrollTop;
          if (state.rawIssues.length > 0) {
            highlightLayer.scrollTop = targetScrollTop;
            highlightLayer.scrollLeft = 0;
          }
        } else {
          textarea.scrollTop = view.scrollTop;
          textarea.scrollLeft = view.scrollLeft;
          gutter.scrollTop = view.scrollTop;
          if (state.rawIssues.length > 0) {
            highlightLayer.scrollTop = view.scrollTop;
            highlightLayer.scrollLeft = view.scrollLeft;
          }
        }
        if (view.wasFocused && view.selectionStart != null && view.selectionEnd != null) {
          textarea.focus({ preventScroll: true });
          const max = textarea.value.length;
          textarea.setSelectionRange(
            Math.min(view.selectionStart, max),
            Math.min(view.selectionEnd, max)
          );
        }
      });
    }

    card.appendChild(body);
    container.appendChild(card);
  }

  function renderExportModal(root) {
    if (!state.showExport) return;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        state.showExport = false;
        render();
      }
    });

    const modal = document.createElement('div');
    modal.className = 'modal';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = 'Save Prompt';
    left.appendChild(title);
    const subtitle = document.createElement('div');
    subtitle.className = 'modal-subtitle';
    subtitle.textContent = 'Choose export format below';
    left.appendChild(subtitle);
    header.appendChild(left);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close-btn';
    close.textContent = '×';
    close.addEventListener('click', () => {
      state.showExport = false;
      render();
    });
    header.appendChild(close);
    modal.appendChild(header);

    const tabs = document.createElement('div');
    tabs.className = 'modal-tabs';
    const aiTab = document.createElement('button');
    aiTab.type = 'button';
    aiTab.className = `tab-btn ${state.exportMode === 'ai' ? 'active' : ''}`;
    aiTab.textContent = 'AI-Ready (clean text)';
    aiTab.addEventListener('click', () => {
      state.exportMode = 'ai';
      render();
    });
    const editorTab = document.createElement('button');
    editorTab.type = 'button';
    editorTab.className = `tab-btn ${state.exportMode === 'editor' ? 'active' : ''}`;
    editorTab.textContent = 'Editor Format (full)';
    editorTab.addEventListener('click', () => {
      state.exportMode = 'editor';
      render();
    });
    tabs.appendChild(aiTab);
    tabs.appendChild(editorTab);
    modal.appendChild(tabs);

    const note = document.createElement('div');
    note.className = 'modal-note';
    note.textContent = state.exportMode === 'ai'
      ? 'Clean XML output ready to paste into your AI prompt. No visual markers.'
      : 'Full format including preamble — use this to reload the file for editing.';
    modal.appendChild(note);

    const preWrap = document.createElement('div');
    preWrap.className = 'modal-pre-wrap';
    const pre = document.createElement('pre');
    pre.className = 'modal-pre';
    pre.textContent = getExportContent();
    preWrap.appendChild(pre);
    modal.appendChild(preWrap);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy-btn';
    copy.textContent = state.copied ? 'Saved!' : 'Save to Clipboard';
    copy.addEventListener('click', async () => {
      try {
        if (nativeHost.isAvailable()) {
          const result = await nativeHost.writeClipboard(getExportContent());
          if (!result?.ok) throw new Error(result?.error || 'Clipboard is unavailable.');
        } else {
          await navigator.clipboard.writeText(getExportContent());
        }
        markCurrentStateAsSaved();
        state.copied = true;
        render();
        setTimeout(() => {
          state.copied = false;
          render();
        }, 1800);
      } catch (error) {
        window.alert(error?.message || 'Copy failed.');
      }
    });
    actions.appendChild(copy);

    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'download-btn';
    download.textContent = 'Save';
    download.addEventListener('click', async () => {
      const ext = state.exportMode === 'ai' ? 'txt' : 'md';
      const filename = `prompt_${state.exportMode === 'ai' ? 'ai_ready' : 'editor'}.${ext}`;
      const saved = await downloadText(filename, getExportContent());
      if (saved) markCurrentStateAsSaved();
    });
    actions.appendChild(download);

    modal.appendChild(actions);
    backdrop.appendChild(modal);
    root.appendChild(backdrop);
  }

  function renderAboutModal(root) {
    if (!state.showAbout) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) {
        state.showAbout = false;
        render();
      }
    });

    const modal = document.createElement('div');
    modal.className = 'modal about-modal';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const left = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = 'About XML Editor';
    left.appendChild(title);
    const subtitle = document.createElement('div');
    subtitle.className = 'modal-subtitle';
    subtitle.textContent = `Version ${APP_VERSION}`;
    left.appendChild(subtitle);
    header.appendChild(left);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close-btn';
    close.textContent = '×';
    close.addEventListener('click', () => {
      state.showAbout = false;
      render();
    });
    header.appendChild(close);
    modal.appendChild(header);

    const body = document.createElement('div');
    body.className = 'about-body';

    const intro = document.createElement('p');
    intro.className = 'about-copy';
    intro.textContent = 'XML Editor is a lightweight local prompt editor for documents that combine a free-form preamble with an XML body.';
    body.appendChild(intro);

    const details = document.createElement('div');
    details.className = 'about-details';

    const rows = [
      ['Version', APP_VERSION],
      ['Mode', 'Local browser app'],
      ['Storage', 'In-memory browser session'],
    ];

    for (const [label, value] of rows) {
      const row = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = label;
      row.appendChild(strong);
      const span = document.createElement('span');
      span.textContent = value;
      row.appendChild(span);
      details.appendChild(row);
    }

    body.appendChild(details);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    root.appendChild(backdrop);
  }

  function render() {
    if (!state.showRaw && !canUseVisualEditor()) {
      state.showRaw = true;
    }

    const app = document.getElementById('app');
    app.replaceChildren();

    const shell = document.createElement('div');
    shell.className = 'app-shell';
    renderHeader(shell);
    renderHelp(shell);

    const main = document.createElement('main');
    const mainInner = document.createElement('div');
    mainInner.className = 'main-inner';
    if (state.showRaw) {
      renderRawCard(mainInner);
    } else {
      renderPreambleCard(mainInner);
      renderStructureCard(mainInner);
    }
    main.appendChild(mainInner);
    shell.appendChild(main);
    renderExportModal(shell);
    renderAboutModal(shell);
    app.appendChild(shell);
    syncNativeDirtyState();
  }

  function sendHeartbeat() {
    if (nativeHost.isAvailable()) return;
    fetch('/__heartbeat', {
      method: 'POST',
      cache: 'no-store',
      keepalive: true,
    }).catch(() => {});
  }

  function startHeartbeat() {
    if (nativeHost.isAvailable()) return;
    sendHeartbeat();
    window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  }

  function handleBeforeUnload(event) {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  }

  function init() {
    state.historyPast = [];
    state.historyFuture = [];
    state.pendingHistory = null;
    loadDocIntoState(parseDocument(SAMPLE_DOC));
    state.collapsed = buildInitialCollapsedState(state.doc);
    markCurrentStateAsSaved();
    window.addEventListener('keydown', handleGlobalKeydown);
    document.addEventListener('mousedown', handleGlobalPointerDown);
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pywebviewready', () => {
      syncNativeDirtyState();
      render();
    });
    startHeartbeat();
    render();
  }

  window.addEventListener('DOMContentLoaded', init);
})();
