// Label template editor — a port of the legacy eventuai label maker
// (admin/public/media/js/printer/editor.js) that reads and writes the same
// design JSON document: { labelConfig, elementIdCounter, textElements[],
// imageElements[], shapeElements[], qrcodeElements[], rotatePreview }.
// The design lives in the #labelDesignField textarea inside the save form;
// every edit re-serializes into it so a plain form POST stores the design.
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var PIXELS_PER_MM = 5.90551181; // 150 dpi
  var svg = document.getElementById('labelSvg');
  var designField = document.getElementById('labelDesignField');
  if (!svg || !designField) return;

  // ---------------------------------------------------------------------
  // Text utilities (CJK/Latin aware wrapping + [@token] replacement)
  // ---------------------------------------------------------------------
  var TextUtils = {
    isCJKChar: function (char) {
      var code = char.charCodeAt(0);
      return (
        (code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0xF900 && code <= 0xFAFF) ||
        (code >= 0x3040 && code <= 0x309F) ||
        (code >= 0x30A0 && code <= 0x30FF) ||
        (code >= 0xAC00 && code <= 0xD7AF) ||
        (code >= 0x20000 && code <= 0x2A6DF) ||
        (code >= 0x2A700 && code <= 0x2B73F) ||
        (code >= 0x2B740 && code <= 0x2B81F) ||
        (code >= 0x2B820 && code <= 0x2CEAF)
      );
    },
    hasCJKChar: function (text) {
      return Array.from(text).some(TextUtils.isCJKChar);
    },
    isLatinChar: function (char) {
      var code = char.charCodeAt(0);
      return (
        (code >= 0x0041 && code <= 0x005A) ||
        (code >= 0x0061 && code <= 0x007A) ||
        (code >= 0x00C0 && code <= 0x00FF)
      );
    },
    // Replace [@key] placeholders. Without tokens the placeholders stay
    // visible. Empty values become a space so the element survives. A line
    // may hold "a || b" alternatives: the first with a filled placeholder wins.
    replaceTokens: function (text, tokens) {
      if (!text) return text;
      if (!tokens || typeof tokens !== 'object' || Object.keys(tokens).length === 0) return text;
      var replaceLine = function (line) {
        return line.replace(/\[@(\w+)\]/g, function (_match, key) {
          var value = tokens[key];
          return value === null || value === undefined || value === '' ? ' ' : String(value);
        });
      };
      var anyPlaceholderFilled = function (segment) {
        var re = /\[@(\w+)\]/g;
        var m;
        var hasPlaceholder = false;
        while ((m = re.exec(segment)) !== null) {
          hasPlaceholder = true;
          var value = tokens[m[1]];
          if (value !== null && value !== undefined && value !== '') return true;
        }
        return !hasPlaceholder;
      };
      return text.split('\n').map(function (line) {
        if (line.indexOf('||') === -1) return replaceLine(line);
        var alternatives = line.split('||');
        for (var i = 0; i < alternatives.length; i++) {
          var trimmed = alternatives[i].trim();
          if (anyPlaceholderFilled(trimmed)) return replaceLine(trimmed);
        }
        return ' ';
      }).join('\n');
    },
    // Insert a line break wherever CJK and Latin runs meet.
    splitCJKAndLatin: function (text) {
      if (!text) return text;
      var chars = Array.from(text);
      var result = '';
      var prevIsCJK = null;
      for (var i = 0; i < chars.length; i++) {
        var char = chars[i];
        var isCJK = TextUtils.isCJKChar(char);
        var isLatin = TextUtils.isLatinChar(char);
        if (prevIsCJK !== null && prevIsCJK !== isCJK && (isCJK || isLatin)) {
          if (result.slice(-1) === ' ') result = result.slice(0, -1);
          result += '\n';
          if (char === ' ') continue;
        }
        result += char;
        if (isCJK || isLatin) prevIsCJK = isCJK;
      }
      return result;
    },
    // Measure in SVG units via a hidden text node inside the label SVG so the
    // generated @font-face rules apply to the measurement too.
    measureText: function (text, fontSize, fontFamily, fontWeight, fontStyle) {
      var textEl = document.createElementNS(SVG_NS, 'text');
      textEl.style.fontSize = fontSize + 'px';
      textEl.style.fontFamily = fontFamily;
      textEl.style.fontWeight = fontWeight || 'normal';
      textEl.style.fontStyle = fontStyle || 'normal';
      textEl.style.visibility = 'hidden';
      textEl.setAttribute('x', '0');
      textEl.setAttribute('y', '0');
      textEl.textContent = text;
      svg.appendChild(textEl);
      var width = 0;
      try { width = textEl.getBBox().width; } catch (e) { /* detached svg */ }
      svg.removeChild(textEl);
      return width;
    },
    wordWrap: function (text, maxWidth, fontSize, fontFamily, balanceOrphans, fontWeight, fontStyle) {
      if (!maxWidth || maxWidth <= 0) return text.split('\n');
      var measure = function (t) { return TextUtils.measureText(t, fontSize, fontFamily, fontWeight, fontStyle); };
      var breakChars = ['、', '，', '。', '；', '：', '！', '？', '」', '）', '】'];
      var lines = [];
      var paragraphs = text.split('\n');

      for (var p = 0; p < paragraphs.length; p++) {
        var paragraph = paragraphs[p];
        var currentLine = '';
        var words = paragraph.split(' ');

        for (var wordIndex = 0; wordIndex < words.length; wordIndex++) {
          var word = words[wordIndex];
          var isLastWord = wordIndex === words.length - 1;

          if (TextUtils.hasCJKChar(word)) {
            if (currentLine && currentLine.slice(-1) !== ' ') {
              if (measure(currentLine + ' ') <= maxWidth) currentLine += ' ';
            }
            // Split the word into alternating Latin / non-Latin segments.
            var segments = [];
            var currentSegment = '';
            var prevIsLatin = null;
            var wordChars = word.split('');
            for (var c = 0; c < wordChars.length; c++) {
              var ch = wordChars[c];
              var chIsLatin = TextUtils.isLatinChar(ch);
              if (prevIsLatin !== null && prevIsLatin !== chIsLatin) {
                if (currentSegment) segments.push({ text: currentSegment, isLatin: prevIsLatin });
                currentSegment = ch;
                prevIsLatin = chIsLatin;
              } else {
                currentSegment += ch;
                if (chIsLatin || TextUtils.isCJKChar(ch)) prevIsLatin = chIsLatin;
              }
            }
            if (currentSegment) segments.push({ text: currentSegment, isLatin: prevIsLatin });

            for (var segIndex = 0; segIndex < segments.length; segIndex++) {
              var segment = segments[segIndex];
              var isLastSegment = segIndex === segments.length - 1;
              if (segment.isLatin) {
                var testLine = currentLine + segment.text;
                if (measure(testLine) > maxWidth) {
                  if (currentLine.trim()) {
                    lines.push(currentLine.trim());
                    currentLine = segment.text;
                  } else {
                    var latinChars = segment.text.split('');
                    for (var lc = 0; lc < latinChars.length; lc++) {
                      if (measure(currentLine + latinChars[lc]) > maxWidth) {
                        lines.push(currentLine.trim());
                        currentLine = latinChars[lc];
                      } else {
                        currentLine += latinChars[lc];
                      }
                    }
                  }
                } else {
                  currentLine = testLine;
                }
              } else {
                var cjkChars = segment.text.split('');
                for (var cc = 0; cc < cjkChars.length; cc++) {
                  var letter = cjkChars[cc];
                  var letterWidth = measure(currentLine + letter);
                  if (letterWidth > maxWidth) {
                    lines.push(currentLine.trim());
                    currentLine = letter;
                  } else {
                    currentLine += letter;
                    if (breakChars.indexOf(letter) !== -1 && letterWidth >= maxWidth * 0.9) {
                      lines.push(currentLine.trim());
                      currentLine = '';
                    }
                  }
                }
              }
              if (isLastSegment && !isLastWord && currentLine) {
                if (measure(currentLine + ' ') <= maxWidth) currentLine += ' ';
              }
            }
          } else {
            var candidate = currentLine ? currentLine + ' ' + word : word;
            if (measure(candidate) > maxWidth) {
              if (currentLine) {
                lines.push(currentLine.trim());
                currentLine = '';
              }
              if (measure(word) > maxWidth) {
                var letters = word.split('');
                for (var li = 0; li < letters.length; li++) {
                  if (measure(currentLine + letters[li]) > maxWidth) {
                    lines.push(currentLine.trim());
                    currentLine = letters[li];
                  } else {
                    currentLine += letters[li];
                  }
                }
              } else {
                currentLine = word;
              }
            } else {
              currentLine = candidate;
            }
          }
        }
        lines.push(currentLine.trim());
      }

      // Rebalance a short orphan last line against a full second-to-last line.
      if (balanceOrphans && lines.length >= 2) {
        var lastLine = lines[lines.length - 1];
        var secondLastLine = lines[lines.length - 2];
        if (lastLine && secondLastLine &&
            measure(lastLine) < maxWidth * 0.4 && measure(secondLastLine) > maxWidth * 0.6) {
          if (TextUtils.hasCJKChar(secondLastLine + lastLine)) {
            var secondLastChars = Array.from(secondLastLine);
            var priorityBreakPoint = null;
            for (var pos = Math.max(0, secondLastChars.length - 5); pos < secondLastChars.length - 1; pos++) {
              if (secondLastChars[pos] === '、') { priorityBreakPoint = pos + 1; break; }
            }
            if (priorityBreakPoint !== null) {
              lines[lines.length - 2] = secondLastChars.slice(0, priorityBreakPoint).join('').trim();
              lines[lines.length - 1] = (secondLastChars.slice(priorityBreakPoint).join('') + lastLine).trim();
            } else {
              var combined = Array.from(secondLastLine + lastLine);
              var breakPoints = [];
              for (var bi = 0; bi < combined.length; bi++) {
                if (breakChars.indexOf(combined[bi]) !== -1) breakPoints.push(bi + 1);
              }
              var bestSplit = Math.ceil(combined.length / 2);
              var bestDiff = Infinity;
              if (breakPoints.length > 0) {
                for (var bp = 0; bp < breakPoints.length; bp++) {
                  var breakPoint = breakPoints[bp];
                  if (breakPoint < combined.length * 0.3 || breakPoint > combined.length * 0.8) continue;
                  var head = combined.slice(0, breakPoint).join('');
                  var tail = combined.slice(breakPoint).join('');
                  if (measure(head) <= maxWidth && measure(tail) <= maxWidth) {
                    var diff = Math.abs(breakPoint - combined.length / 2);
                    if (diff < bestDiff) { bestDiff = diff; bestSplit = breakPoint; }
                  }
                }
              } else {
                for (var si = Math.floor(combined.length * 0.4); si <= Math.ceil(combined.length * 0.7); si++) {
                  var head2 = combined.slice(0, si).join('');
                  var tail2 = combined.slice(si).join('');
                  var w1 = measure(head2);
                  var w2 = measure(tail2);
                  if (w1 <= maxWidth && w2 <= maxWidth) {
                    var diff2 = Math.abs(w1 - w2);
                    if (diff2 < bestDiff) { bestDiff = diff2; bestSplit = si; }
                  }
                }
              }
              lines[lines.length - 2] = combined.slice(0, bestSplit).join('').trim();
              lines[lines.length - 1] = combined.slice(bestSplit).join('').trim();
            }
          } else {
            var wordsInLine = secondLastLine.split(' ');
            if (wordsInLine.length > 1) {
              var bestWordSplit = wordsInLine.length;
              var bestWordDiff = Infinity;
              for (var wi = Math.floor(wordsInLine.length / 2); wi < wordsInLine.length; wi++) {
                var newSecondLast = wordsInLine.slice(0, wi).join(' ');
                var newLast = wordsInLine.slice(wi).join(' ') + ' ' + lastLine;
                if (measure(newSecondLast) <= maxWidth && measure(newLast) <= maxWidth) {
                  var wdiff = Math.abs(measure(newSecondLast) - measure(newLast));
                  if (wdiff < bestWordDiff) { bestWordDiff = wdiff; bestWordSplit = wi; }
                }
              }
              if (bestWordSplit < wordsInLine.length) {
                lines[lines.length - 2] = wordsInLine.slice(0, bestWordSplit).join(' ').trim();
                lines[lines.length - 1] = (wordsInLine.slice(bestWordSplit).join(' ') + ' ' + lastLine).trim();
              }
            }
          }
        }
      }

      return lines.filter(function (line) { return line !== ''; });
    }
  };

  // ---------------------------------------------------------------------
  // Editor state
  // ---------------------------------------------------------------------
  var el = function (id) { return document.getElementById(id); };
  var background = el('labelBackground');
  var textGroup = el('textElementsGroup');
  var editor = {
    labelConfig: { width: 60, height: 30, backgroundColor: '#ffffff', borderColor: '#000000', borderWidth: 1, borderRadius: 0 },
    elementIdCounter: 0,
    textElements: [],
    imageElements: [],
    shapeElements: [],
    qrcodeElements: [],
    selectedElement: null,
    selectedElementType: null,
    isRotated: false,
    isLoading: false,
    tokens: {},
    adhocTokens: {},
    dragState: { isDragging: false, element: null, offset: { x: 0, y: 0 } }
  };

  var tokensField = el('labelTokens');
  if (tokensField && tokensField.value.trim()) {
    try { editor.tokens = JSON.parse(tokensField.value) || {}; } catch (e) { /* no preview tokens */ }
  }

  var controls = {
    fallback: el('labelEditorFallback'),
    wrapper: el('labelControls'),
    saveForm: el('labelSaveForm'),
    unsavedHint: el('unsavedHint'),
    exportButton: el('exportLabel'),
    importButton: el('importLabel'),
    fileInput: el('labelFileInput'),
    guestForm: el('labelGuestForm'),
    guestListSelect: el('guestListSelect'),
    guestSelect: el('guestSelect'),
    guestSearchInput: el('guestSearchInput'),
    loadGuestButton: el('loadGuestButton'),
    printButton: el('printLabelButton'),
    selectedGuestName: el('selectedGuestName'),
    rotatePreview: el('rotatePreview'),
    svgWrapper: el('svgWrapper'),
    actualSize: el('actualSize'),
    elementSelector: el('elementSelector'),
    removeButton: el('removeTextBox'),
    positionPanel: el('positionPanel'),
    parentElement: el('parentElement'),
    clearParent: el('clearParent'),
    anchorX: el('anchorX'),
    anchorY: el('anchorY'),
    textX: el('textX'),
    textY: el('textY'),
    textSettings: el('textSettings'),
    labelText: el('labelText'),
    fontSize: el('fontSize'),
    fontSizeSecondary: el('fontSizeSecondary'),
    fontSizeTertiary: el('fontSizeTertiary'),
    lineHeight: el('lineHeight'),
    maxWidth: el('maxWidth'),
    maxLines: el('maxLines'),
    autoSplit: el('autoSplitCJKLatin'),
    balanceOrphans: el('balanceOrphans'),
    fontFamily: el('fontFamily'),
    fontUnicodePrimary: el('fontUnicodePrimary'),
    fontFamilySecondary: el('fontFamilySecondary'),
    fontUnicodeSecondary: el('fontUnicodeSecondary'),
    fontFamilyTertiary: el('fontFamilyTertiary'),
    fontUnicodeTertiary: el('fontUnicodeTertiary'),
    fontFamilyFallback: el('fontFamilyFallback'),
    textColor: el('textColor'),
    textAlign: el('textAlign'),
    textGrowDirection: el('textGrowDirection'),
    textRotation: el('textRotation'),
    boldText: el('boldText'),
    italicText: el('italicText'),
    underlineText: el('underlineText'),
    qrcodeSettings: el('qrcodeSettings'),
    qrcodeText: el('qrcodeText'),
    qrcodeSize: el('qrcodeSize'),
    qrcodeErrorLevel: el('qrcodeErrorLevel'),
    qrcodeRotation: el('qrcodeRotation'),
    imageSettings: el('imageSettings'),
    imageWidth: el('imageWidth'),
    imageHeight: el('imageHeight'),
    imageLockRatio: el('imageLockRatio'),
    imageRotation: el('imageRotation'),
    shapeSettings: el('shapeSettings'),
    shapeWidth: el('shapeWidth'),
    shapeHeight: el('shapeHeight'),
    shapeCornerRadius: el('shapeCornerRadius'),
    shapeStrokeWidth: el('shapeStrokeWidth'),
    shapeRotation: el('shapeRotation'),
    shapeFill: el('shapeFill'),
    shapeFillNone: el('shapeFillNone'),
    shapeStroke: el('shapeStroke'),
    addTextBox: el('addTextBox'),
    addQRCode: el('addQRCode'),
    addRectangle: el('addRectangle'),
    addCircle: el('addCircle'),
    addImage: el('addImage'),
    imageInput: el('imageInput'),
    imageUrlInput: el('imageUrlInput'),
    addImageUrl: el('addImageUrl'),
    labelWidth: el('labelWidth'),
    labelHeight: el('labelHeight'),
    backgroundColor: el('backgroundColor'),
    resetLabel: el('resetLabel'),
    adhocPanel: el('adhocValuesPanel'),
    adhocContainer: el('adhocInputsContainer'),
    clearAdhocValues: el('clearAdhocValues')
  };

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  function allElements() {
    return editor.textElements.concat(editor.imageElements, editor.shapeElements, editor.qrcodeElements);
  }

  function findElementById(id) {
    var elements = allElements();
    for (var i = 0; i < elements.length; i++) {
      if (elements[i].getAttribute('data-element-id') === id) return elements[i];
    }
    return null;
  }

  function generateElementId(type) {
    editor.elementIdCounter++;
    return type + '-' + editor.elementIdCounter;
  }

  function bumpCounterFromId(elementId) {
    var idNum = parseInt(String(elementId).split('-')[1], 10);
    if (idNum && idNum >= editor.elementIdCounter) editor.elementIdCounter = idNum;
  }

  function effectiveTokens() {
    var merged = {};
    Object.keys(editor.tokens).forEach(function (key) { merged[key] = editor.tokens[key]; });
    Object.keys(editor.adhocTokens).forEach(function (key) { merged[key] = editor.adhocTokens[key]; });
    return merged;
  }

  function rgbToHex(rgb) {
    if (!rgb) return '#000000';
    if (rgb[0] === '#') return rgb;
    var m = rgb.match(/\d+/g);
    if (!m || m.length < 3) return '#000000';
    return '#' + m.slice(0, 3).map(function (n) {
      return ('0' + parseInt(n, 10).toString(16)).slice(-2);
    }).join('');
  }

  function quoteFontName(fontName) {
    if (!fontName) return '';
    return "'" + fontName.replace(/^['"]|['"]$/g, '') + "'";
  }

  function getPageLengthPixel(dpi) {
    // The label has a 6mm cutting margin (legacy encoder.getPageLengthPixel).
    return Math.floor((editor.labelConfig.height - 6) * (dpi / 25.4));
  }

  function updateSVGDimensions() {
    var printableMarginY = Math.floor(4 * PIXELS_PER_MM);
    var printableMarginL = Math.floor(3 * PIXELS_PER_MM);
    var printableMarginR = 2;
    var widthPx = Math.floor(editor.labelConfig.width * PIXELS_PER_MM) - printableMarginL - printableMarginR;
    var heightPx = getPageLengthPixel(150) - printableMarginY;
    svg.setAttribute('width', widthPx);
    svg.setAttribute('height', heightPx);
    svg.setAttribute('viewBox', '0 0 ' + widthPx + ' ' + heightPx);
    background.setAttribute('width', widthPx);
    background.setAttribute('height', heightPx);
    updateBackground();
    if (controls.actualSize) {
      controls.actualSize.textContent = editor.labelConfig.width + 'mm × ' + editor.labelConfig.height + 'mm';
    }
  }

  function updateBackground() {
    background.setAttribute('fill', editor.labelConfig.backgroundColor);
    background.setAttribute('stroke', 'none');
    if (editor.labelConfig.borderRadius > 0) {
      background.setAttribute('rx', editor.labelConfig.borderRadius);
      background.setAttribute('ry', editor.labelConfig.borderRadius);
    } else {
      background.removeAttribute('rx');
      background.removeAttribute('ry');
    }
  }

  // ---------------------------------------------------------------------
  // Fonts: per-element smart font-face with unicode ranges
  // ---------------------------------------------------------------------
  function updateFontFaces() {
    var styleEl = svg.querySelector('#dynamic-fonts');
    if (!styleEl) {
      styleEl = document.createElementNS(SVG_NS, 'style');
      styleEl.setAttribute('id', 'dynamic-fonts');
      svg.insertBefore(styleEl, svg.firstChild);
    }
    var css = '';
    editor.textElements.forEach(function (textEl) {
      var primary = textEl.getAttribute('data-font-primary');
      if (primary === null) return;
      var secondary = textEl.getAttribute('data-font-secondary') || '';
      var tertiary = textEl.getAttribute('data-font-tertiary') || '';
      var fallback = textEl.getAttribute('data-font-fallback') || 'sans-serif';
      var uPrimary = textEl.getAttribute('data-font-unicode-primary') || '';
      var uSecondary = textEl.getAttribute('data-font-unicode-secondary') || '';
      var uTertiary = textEl.getAttribute('data-font-unicode-tertiary') || '';
      var elementId = textEl.getAttribute('data-element-id');
      if (!elementId) return;
      var generatedName = 'smart-font-' + elementId;
      var hasValidFont = false;
      [{ fam: tertiary, range: uTertiary }, { fam: secondary, range: uSecondary }, { fam: primary, range: uPrimary }]
        .forEach(function (def) {
          if (!def.fam) return;
          hasValidFont = true;
          css += '@font-face {\n  font-family: "' + generatedName + '";\n  src: local(' + quoteFontName(def.fam) + ');\n';
          if (def.range) css += '  unicode-range: ' + def.range + ';\n';
          css += '}\n';
        });
      if (hasValidFont) textEl.style.fontFamily = '"' + generatedName + '", ' + fallback;
    });
    styleEl.textContent = css;
    var headStyle = document.getElementById('dynamic-fonts-head');
    if (!headStyle) {
      headStyle = document.createElement('style');
      headStyle.id = 'dynamic-fonts-head';
      document.head.appendChild(headStyle);
    }
    headStyle.textContent = css;
  }

  // ---------------------------------------------------------------------
  // Relative positioning (parent / anchor / offset)
  // ---------------------------------------------------------------------
  function getElementBounds(element) {
    var tagName = element.tagName.toLowerCase();
    if (tagName === 'image' || tagName === 'rect') {
      return {
        x: parseFloat(element.getAttribute('x')) || 0,
        y: parseFloat(element.getAttribute('y')) || 0,
        width: parseFloat(element.getAttribute('width')) || 0,
        height: parseFloat(element.getAttribute('height')) || 0
      };
    }
    if (tagName === 'ellipse' || tagName === 'circle') {
      var cx = parseFloat(element.getAttribute('cx')) || 0;
      var cy = parseFloat(element.getAttribute('cy')) || 0;
      var rx = parseFloat(element.getAttribute('rx')) || 0;
      var ry = parseFloat(element.getAttribute('ry')) || rx;
      return { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 };
    }
    var x = parseFloat(element.getAttribute('x')) || 0;
    var y = parseFloat(element.getAttribute('y')) || 0;
    try {
      var bbox = element.getBBox();
      return { x: x, y: y, width: bbox.width, height: bbox.height };
    } catch (e) {
      var fontSize = parseInt(element.style.fontSize, 10) || 16;
      var lineHeight = parseFloat(element.getAttribute('data-line-height')) || 1.2;
      var numLines = element.querySelectorAll('tspan').length || 1;
      return { x: x, y: y, width: 100, height: fontSize * lineHeight * numLines };
    }
  }

  function getRotationCenter(element, bounds) {
    if (element.tagName.toLowerCase() === 'image') {
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    }
    return { x: bounds.x, y: bounds.y };
  }

  function rotatePoint(px, py, cx, cy, angleDegrees) {
    var rad = (angleDegrees * Math.PI) / 180;
    var cos = Math.cos(rad);
    var sin = Math.sin(rad);
    var dx = px - cx;
    var dy = py - cy;
    return { x: dx * cos - dy * sin + cx, y: dx * sin + dy * cos + cy };
  }

  function calculateAbsolutePosition(parentId, anchorX, anchorY, offsetX, offsetY) {
    var baseX = 0;
    var baseY = 0;
    if (parentId === 'label') {
      var labelWidth = parseFloat(svg.getAttribute('width')) || 0;
      var labelHeight = parseFloat(svg.getAttribute('height')) || 0;
      if (anchorX === 'center') baseX = labelWidth / 2;
      else if (anchorX === 'right') baseX = labelWidth;
      if (anchorY === 'middle') baseY = labelHeight / 2;
      else if (anchorY === 'bottom') baseY = labelHeight;
      return { x: baseX + offsetX, y: baseY + offsetY };
    }
    var parentEl = findElementById(parentId);
    if (!parentEl) return { x: offsetX, y: offsetY };
    var bounds = getElementBounds(parentEl);
    var rotation = parseFloat(parentEl.getAttribute('data-rotation')) || 0;
    var localAnchorX = anchorX === 'center' ? bounds.width / 2 : anchorX === 'right' ? bounds.width : 0;
    var localAnchorY = anchorY === 'middle' ? bounds.height / 2 : anchorY === 'bottom' ? bounds.height : 0;
    localAnchorX += offsetX;
    localAnchorY += offsetY;
    if (rotation === 0) return { x: bounds.x + localAnchorX, y: bounds.y + localAnchorY };
    var center = getRotationCenter(parentEl, bounds);
    return rotatePoint(bounds.x + localAnchorX, bounds.y + localAnchorY, center.x, center.y, rotation);
  }

  function applyRotationTransform(element, x, y) {
    var rotation = element.getAttribute('data-rotation') || '0';
    var tagName = element.tagName.toLowerCase();
    if (parseInt(rotation, 10) === 0) {
      element.removeAttribute('transform');
      return;
    }
    if (tagName === 'image' || tagName === 'rect') {
      var width = parseFloat(element.getAttribute('width')) || 0;
      var height = parseFloat(element.getAttribute('height')) || 0;
      element.setAttribute('transform', 'rotate(' + rotation + ', ' + (x + width / 2) + ', ' + (y + height / 2) + ')');
    } else {
      element.setAttribute('transform', 'rotate(' + rotation + ', ' + x + ', ' + y + ')');
    }
  }

  function setElementPosition(element, x, y) {
    var tagName = element.tagName.toLowerCase();
    if (tagName === 'ellipse' || tagName === 'circle') {
      element.setAttribute('cx', x);
      element.setAttribute('cy', y);
    } else {
      element.setAttribute('x', x);
      element.setAttribute('y', y);
      if (tagName === 'text') {
        element.querySelectorAll('tspan').forEach(function (tspan) { tspan.setAttribute('x', x); });
      }
    }
    applyRotationTransform(element, x, y);
  }

  function updateChildPositions(parentElement) {
    var parentId = parentElement.getAttribute('data-element-id');
    if (!parentId) return;
    allElements().forEach(function (child) {
      if (child === parentElement) return;
      if (child.getAttribute('data-parent') !== parentId) return;
      var anchorX = child.getAttribute('data-anchor-x') || 'left';
      var anchorY = child.getAttribute('data-anchor-y') || 'top';
      var offsetX = parseFloat(child.getAttribute('data-offset-x')) || 0;
      var offsetY = parseFloat(child.getAttribute('data-offset-y')) || 0;
      var pos = calculateAbsolutePosition(parentId, anchorX, anchorY, offsetX, offsetY);
      setElementPosition(child, pos.x, pos.y);
      updateChildPositions(child);
    });
  }

  function updateAllRelativePositions() {
    allElements().forEach(function (element) {
      var parent = element.getAttribute('data-parent');
      if (parent === 'label' || !parent) updateChildPositions(element);
    });
    updateSelectionIndicator();
  }

  // ---------------------------------------------------------------------
  // Text rendering (token replacement + wrapping + size fallback)
  // ---------------------------------------------------------------------
  function applyTextLayout(element) {
    var originalText = element.getAttribute('data-text') || '';
    var tokens = effectiveTokens();
    var primaryFontSize = parseInt(element.getAttribute('data-font-size'), 10) || 16;
    var secondaryFontSize = parseInt(element.getAttribute('data-font-size-secondary'), 10) || 0;
    var tertiaryFontSize = parseInt(element.getAttribute('data-font-size-tertiary'), 10) || 0;
    var lineHeightEm = parseFloat(element.getAttribute('data-line-height')) || 1.2;
    var maxWidthValue = parseInt(element.getAttribute('data-max-width'), 10) || 0;
    var maxLinesValue = parseInt(element.getAttribute('data-max-lines'), 10) || 0;
    var autoSplit = element.getAttribute('data-auto-split') === '1';
    var balanceOrphans = element.getAttribute('data-balance-orphans') === '1';
    var fontFamily = element.style.fontFamily || 'Arial, sans-serif';
    var fontWeight = element.style.fontWeight || 'normal';
    var fontStyle = element.style.fontStyle || 'normal';
    var x = element.getAttribute('x');

    var rendered = TextUtils.replaceTokens(originalText, tokens);
    if (autoSplit) rendered = TextUtils.splitCJKAndLatin(rendered);

    var finalFontSize = primaryFontSize;
    var lines;
    if (maxLinesValue > 0 && maxWidthValue > 0) {
      lines = TextUtils.wordWrap(rendered, maxWidthValue, primaryFontSize, fontFamily, balanceOrphans, fontWeight, fontStyle);
      if (lines.length > maxLinesValue && secondaryFontSize > 0) {
        lines = TextUtils.wordWrap(rendered, maxWidthValue, secondaryFontSize, fontFamily, balanceOrphans, fontWeight, fontStyle);
        finalFontSize = secondaryFontSize;
        if (lines.length > maxLinesValue && tertiaryFontSize > 0) {
          lines = TextUtils.wordWrap(rendered, maxWidthValue, tertiaryFontSize, fontFamily, balanceOrphans, fontWeight, fontStyle);
          finalFontSize = tertiaryFontSize;
        }
      }
    } else {
      lines = maxWidthValue > 0
        ? TextUtils.wordWrap(rendered, maxWidthValue, primaryFontSize, fontFamily, balanceOrphans, fontWeight, fontStyle)
        : rendered.split('\n');
    }

    var lineHeightPx = finalFontSize * lineHeightEm;
    element.setAttribute('data-font-size-used', finalFontSize);
    element.style.fontSize = finalFontSize + 'px';
    element.textContent = '';
    var growDirection = element.getAttribute('data-grow-direction') || 'down';
    var firstLineDy = '0';
    if (growDirection === 'up' && lines.length > 1) {
      firstLineDy = (-(lines.length - 1) * lineHeightPx) + 'px';
    } else if (growDirection === 'center' && lines.length > 1) {
      firstLineDy = (-((lines.length - 1) / 2) * lineHeightPx) + 'px';
    }
    lines.forEach(function (line, index) {
      var tspan = document.createElementNS(SVG_NS, 'tspan');
      tspan.setAttribute('x', x);
      tspan.setAttribute('dy', index === 0 ? firstLineDy : lineHeightPx + 'px');
      tspan.textContent = line || ' ';
      element.appendChild(tspan);
    });
  }

  function rerenderAllTextElements() {
    editor.textElements.forEach(function (element) { applyTextLayout(element); });
    updateFontFaces();
    updateAllRelativePositions();
    rerenderAllQRCodeElements();
  }

  // ---------------------------------------------------------------------
  // QR codes
  // ---------------------------------------------------------------------
  function generateQRCodeDataUrl(text, errorLevel) {
    if (typeof window.qrcode !== 'function') return null;
    var qr = window.qrcode(0, errorLevel || 'M');
    qr.addData(text);
    qr.make();
    var moduleCount = qr.getModuleCount();
    var moduleSize = 10;
    var size = moduleCount * moduleSize;
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (var row = 0; row < moduleCount; row++) {
      for (var col = 0; col < moduleCount; col++) {
        if (qr.isDark(row, col)) ctx.fillRect(col * moduleSize, row * moduleSize, moduleSize, moduleSize);
      }
    }
    return canvas.toDataURL('image/png');
  }

  function refreshQRCodeImage(element) {
    var qrText = element.getAttribute('data-qr-text') || '';
    var errorLevel = element.getAttribute('data-qr-error-level') || 'M';
    var resolved = TextUtils.replaceTokens(qrText, effectiveTokens());
    try {
      var dataUrl = generateQRCodeDataUrl(resolved || ' ', errorLevel);
      if (dataUrl) element.setAttribute('href', dataUrl);
    } catch (e) { /* invalid QR payload; keep previous image */ }
  }

  function rerenderAllQRCodeElements() {
    editor.qrcodeElements.forEach(refreshQRCodeImage);
  }

  // ---------------------------------------------------------------------
  // Element restore (from design JSON) and creation
  // ---------------------------------------------------------------------
  function setRelativeAttributes(element, data) {
    element.setAttribute('data-parent', data.parent || 'label');
    element.setAttribute('data-anchor-x', data.anchorX || 'left');
    element.setAttribute('data-anchor-y', data.anchorY || 'top');
    element.setAttribute('data-offset-x', data.offsetX || '0');
    element.setAttribute('data-offset-y', data.offsetY || '0');
  }

  function restoreTextElement(data) {
    var textElement = document.createElementNS(SVG_NS, 'text');
    var elementId = data.elementId || generateElementId('text');
    textElement.setAttribute('data-element-id', elementId);
    if (data.elementName) textElement.setAttribute('data-element-name', data.elementName);
    bumpCounterFromId(elementId);

    textElement.setAttribute('x', data.x);
    textElement.setAttribute('y', data.y);
    textElement.setAttribute('class', 'svg-text');
    textElement.setAttribute('text-anchor', data.textAnchor || 'start');
    textElement.style.fontFamily = data.fontFamily || 'Arial, sans-serif';
    textElement.setAttribute('data-font-primary', data.fontPrimary || '');
    textElement.setAttribute('data-font-secondary', data.fontSecondary || '');
    textElement.setAttribute('data-font-tertiary', data.fontTertiary || '');
    textElement.setAttribute('data-font-fallback', data.fontFallback || '');
    textElement.setAttribute('data-font-unicode-primary', data.fontUnicodePrimary || '');
    textElement.setAttribute('data-font-unicode-secondary', data.fontUnicodeSecondary || '');
    textElement.setAttribute('data-font-unicode-tertiary', data.fontUnicodeTertiary || '');
    textElement.style.fill = data.fill || '#000000';
    textElement.style.fontWeight = data.fontWeight || 'normal';
    textElement.style.fontStyle = data.fontStyle || 'normal';
    textElement.style.textDecoration = data.textDecoration || 'none';
    var rotation = data.rotation || '0';
    textElement.setAttribute('data-rotation', rotation);
    if (parseInt(rotation, 10) !== 0) {
      textElement.setAttribute('transform', 'rotate(' + rotation + ', ' + data.x + ', ' + data.y + ')');
    }
    textElement.setAttribute('data-text', data.text || 'Text');
    textElement.setAttribute('data-font-size', parseInt(data.fontSize, 10) || 16);
    textElement.setAttribute('data-font-size-secondary', parseInt(data.fontSizeSecondary, 10) || 0);
    textElement.setAttribute('data-font-size-tertiary', parseInt(data.fontSizeTertiary, 10) || 0);
    textElement.setAttribute('data-line-height', parseFloat(data.lineHeight) || 1.2);
    textElement.setAttribute('data-max-width', parseInt(data.maxWidth, 10) || 0);
    textElement.setAttribute('data-max-lines', parseInt(data.maxLines, 10) || 0);
    textElement.setAttribute('data-auto-split', data.autoSplit !== '0' ? '1' : '0');
    textElement.setAttribute('data-balance-orphans', data.balanceOrphans === '1' ? '1' : '0');
    textElement.setAttribute('data-grow-direction', data.growDirection || 'down');
    setRelativeAttributes(textElement, data);
    textGroup.appendChild(textElement);
    editor.textElements.push(textElement);
    applyTextLayout(textElement);
    return textElement;
  }

  function restoreImageElement(data) {
    var imageElement = document.createElementNS(SVG_NS, 'image');
    var elementId = data.elementId || generateElementId('image');
    imageElement.setAttribute('data-element-id', elementId);
    if (data.elementName) imageElement.setAttribute('data-element-name', data.elementName);
    bumpCounterFromId(elementId);
    imageElement.setAttribute('x', data.x);
    imageElement.setAttribute('y', data.y);
    imageElement.setAttribute('width', data.width);
    imageElement.setAttribute('height', data.height);
    imageElement.setAttribute('href', data.href);
    imageElement.setAttribute('data-original-width', data.originalWidth || data.width);
    imageElement.setAttribute('data-original-height', data.originalHeight || data.height);
    imageElement.classList.add('svg-image');
    imageElement.style.cursor = 'move';
    imageElement.setAttribute('data-rotation', data.rotation || '0');
    applyRotationTransform(imageElement, parseFloat(data.x) || 0, parseFloat(data.y) || 0);
    setRelativeAttributes(imageElement, data);
    textGroup.appendChild(imageElement);
    editor.imageElements.push(imageElement);
    return imageElement;
  }

  function restoreQRCodeElement(data) {
    var imageElement = document.createElementNS(SVG_NS, 'image');
    var elementId = data.elementId || generateElementId('qrcode');
    imageElement.setAttribute('data-element-id', elementId);
    imageElement.setAttribute('data-element-type', 'qrcode');
    if (data.elementName) imageElement.setAttribute('data-element-name', data.elementName);
    bumpCounterFromId(elementId);
    var size = data.size || '50';
    imageElement.setAttribute('x', data.x);
    imageElement.setAttribute('y', data.y);
    imageElement.setAttribute('width', size);
    imageElement.setAttribute('height', size);
    imageElement.setAttribute('data-qr-text', data.qrText || '');
    imageElement.setAttribute('data-qr-error-level', data.errorLevel || 'M');
    imageElement.classList.add('svg-image');
    imageElement.style.cursor = 'move';
    imageElement.setAttribute('data-rotation', data.rotation || '0');
    applyRotationTransform(imageElement, parseFloat(data.x) || 0, parseFloat(data.y) || 0);
    setRelativeAttributes(imageElement, data);
    textGroup.appendChild(imageElement);
    editor.qrcodeElements.push(imageElement);
    refreshQRCodeImage(imageElement);
    return imageElement;
  }

  function restoreShapeElement(data) {
    var shapeType = data.shapeType;
    var shapeElement;
    if (shapeType === 'rect') {
      shapeElement = document.createElementNS(SVG_NS, 'rect');
      shapeElement.setAttribute('x', data.x);
      shapeElement.setAttribute('y', data.y);
      shapeElement.setAttribute('width', data.width);
      shapeElement.setAttribute('height', data.height);
      if (parseFloat(data.rx) > 0) {
        shapeElement.setAttribute('rx', data.rx);
        shapeElement.setAttribute('ry', data.rx);
      }
    } else if (shapeType === 'ellipse') {
      shapeElement = document.createElementNS(SVG_NS, 'ellipse');
      shapeElement.setAttribute('cx', data.cx);
      shapeElement.setAttribute('cy', data.cy);
      shapeElement.setAttribute('rx', data.rx);
      shapeElement.setAttribute('ry', data.ry);
    } else {
      return null;
    }
    var elementId = data.elementId || generateElementId('shape');
    shapeElement.setAttribute('data-element-id', elementId);
    if (data.elementName) shapeElement.setAttribute('data-element-name', data.elementName);
    bumpCounterFromId(elementId);
    shapeElement.setAttribute('fill', data.fill || '#ffffff');
    shapeElement.setAttribute('stroke', data.stroke || '#000000');
    shapeElement.setAttribute('stroke-width', data.strokeWidth || '1');
    shapeElement.setAttribute('data-shape-type', shapeType);
    shapeElement.classList.add('svg-shape');
    shapeElement.style.cursor = 'move';
    shapeElement.setAttribute('data-rotation', data.rotation || '0');
    if (parseInt(data.rotation || '0', 10) !== 0) {
      var cx2;
      var cy2;
      if (shapeType === 'rect') {
        cx2 = (parseFloat(data.x) || 0) + (parseFloat(data.width) || 0) / 2;
        cy2 = (parseFloat(data.y) || 0) + (parseFloat(data.height) || 0) / 2;
      } else {
        cx2 = parseFloat(data.cx) || 0;
        cy2 = parseFloat(data.cy) || 0;
      }
      shapeElement.setAttribute('transform', 'rotate(' + data.rotation + ', ' + cx2 + ', ' + cy2 + ')');
    }
    setRelativeAttributes(shapeElement, data);
    textGroup.appendChild(shapeElement);
    editor.shapeElements.push(shapeElement);
    return shapeElement;
  }

  // ---------------------------------------------------------------------
  // Serialize back into the legacy design JSON shape
  // ---------------------------------------------------------------------
  function collectSettings() {
    var domChildren = Array.prototype.slice.call(textGroup.children);
    var getZIndex = function (element) { return domChildren.indexOf(element); };
    var relative = function (element) {
      return {
        rotation: element.getAttribute('data-rotation') || '0',
        parent: element.getAttribute('data-parent') || 'label',
        anchorX: element.getAttribute('data-anchor-x') || 'left',
        anchorY: element.getAttribute('data-anchor-y') || 'top',
        offsetX: element.getAttribute('data-offset-x') || '0',
        offsetY: element.getAttribute('data-offset-y') || '0',
        zIndex: getZIndex(element)
      };
    };
    return {
      labelConfig: editor.labelConfig,
      elementIdCounter: editor.elementIdCounter,
      textElements: editor.textElements.filter(function (element) {
        var dataText = element.getAttribute('data-text') || element.textContent || '';
        return dataText.trim() !== '' && element.getAttribute('x') !== null && element.getAttribute('y') !== null;
      }).map(function (element) {
        return Object.assign({
          elementId: element.getAttribute('data-element-id'),
          elementName: element.getAttribute('data-element-name') || '',
          x: element.getAttribute('x'),
          y: element.getAttribute('y'),
          text: element.getAttribute('data-text') || element.textContent,
          fontSize: element.getAttribute('data-font-size') || '16',
          fontSizeSecondary: element.getAttribute('data-font-size-secondary') || '0',
          fontSizeTertiary: element.getAttribute('data-font-size-tertiary') || '0',
          lineHeight: element.getAttribute('data-line-height') || '1.2',
          maxWidth: element.getAttribute('data-max-width') || '0',
          maxLines: element.getAttribute('data-max-lines') || '0',
          autoSplit: element.getAttribute('data-auto-split') || '1',
          balanceOrphans: element.getAttribute('data-balance-orphans') || '0',
          fontFamily: element.style.fontFamily || 'Arial, sans-serif',
          fontPrimary: element.getAttribute('data-font-primary') || '',
          fontSecondary: element.getAttribute('data-font-secondary') || '',
          fontTertiary: element.getAttribute('data-font-tertiary') || '',
          fontFallback: element.getAttribute('data-font-fallback') || 'Arial, sans-serif',
          fontUnicodePrimary: element.getAttribute('data-font-unicode-primary') || '',
          fontUnicodeSecondary: element.getAttribute('data-font-unicode-secondary') || '',
          fontUnicodeTertiary: element.getAttribute('data-font-unicode-tertiary') || '',
          fill: element.style.fill || '#000000',
          fontWeight: element.style.fontWeight || 'normal',
          fontStyle: element.style.fontStyle || 'normal',
          textDecoration: element.style.textDecoration || 'none',
          textAnchor: element.getAttribute('text-anchor') || 'start',
          growDirection: element.getAttribute('data-grow-direction') || 'down'
        }, relative(element));
      }),
      imageElements: editor.imageElements.filter(function (element) {
        return element.getAttribute('href');
      }).map(function (element) {
        return Object.assign({
          elementId: element.getAttribute('data-element-id'),
          elementName: element.getAttribute('data-element-name') || '',
          x: element.getAttribute('x'),
          y: element.getAttribute('y'),
          width: element.getAttribute('width'),
          height: element.getAttribute('height'),
          href: element.getAttribute('href'),
          originalWidth: element.getAttribute('data-original-width'),
          originalHeight: element.getAttribute('data-original-height')
        }, relative(element));
      }),
      shapeElements: editor.shapeElements.map(function (element) {
        var shapeType = element.getAttribute('data-shape-type');
        var data = Object.assign({
          elementId: element.getAttribute('data-element-id'),
          elementName: element.getAttribute('data-element-name') || '',
          shapeType: shapeType,
          fill: element.getAttribute('fill') || '#ffffff',
          stroke: element.getAttribute('stroke') || '#000000',
          strokeWidth: element.getAttribute('stroke-width') || '1'
        }, relative(element));
        if (shapeType === 'rect') {
          data.x = element.getAttribute('x');
          data.y = element.getAttribute('y');
          data.width = element.getAttribute('width');
          data.height = element.getAttribute('height');
          data.rx = element.getAttribute('rx') || '0';
        } else if (shapeType === 'ellipse') {
          data.cx = element.getAttribute('cx');
          data.cy = element.getAttribute('cy');
          data.rx = element.getAttribute('rx');
          data.ry = element.getAttribute('ry');
        }
        return data;
      }),
      qrcodeElements: editor.qrcodeElements.filter(function (element) {
        return element.getAttribute('data-qr-text');
      }).map(function (element) {
        return Object.assign({
          elementId: element.getAttribute('data-element-id'),
          elementName: element.getAttribute('data-element-name') || '',
          x: element.getAttribute('x'),
          y: element.getAttribute('y'),
          size: element.getAttribute('width'),
          qrText: element.getAttribute('data-qr-text'),
          errorLevel: element.getAttribute('data-qr-error-level') || 'M'
        }, relative(element));
      }),
      rotatePreview: editor.isRotated,
      exportedAt: new Date().toISOString(),
      version: '1.0'
    };
  }

  var dirty = false;
  function syncDesignField(markDirty) {
    if (editor.isLoading) return;
    designField.value = JSON.stringify(collectSettings());
    if (markDirty !== false) {
      dirty = true;
      if (controls.unsavedHint) controls.unsavedHint.hidden = false;
    }
  }

  // ---------------------------------------------------------------------
  // Load a design document into the editor
  // ---------------------------------------------------------------------
  function clearAllElements() {
    editor.textElements = [];
    editor.imageElements = [];
    editor.shapeElements = [];
    editor.qrcodeElements = [];
    editor.selectedElement = null;
    editor.selectedElementType = null;
    textGroup.textContent = '';
  }

  function applySettings(settings) {
    editor.isLoading = true;
    clearAllElements();
    editor.labelConfig = Object.assign(
      { width: 60, height: 30, backgroundColor: '#ffffff', borderColor: '#000000', borderWidth: 1, borderRadius: 0 },
      settings.labelConfig || {}
    );
    editor.elementIdCounter = settings.elementIdCounter || 0;
    if (controls.labelWidth) controls.labelWidth.value = editor.labelConfig.width;
    if (controls.labelHeight) controls.labelHeight.value = editor.labelConfig.height;
    if (controls.backgroundColor) controls.backgroundColor.value = rgbToHex(editor.labelConfig.backgroundColor);
    updateSVGDimensions();

    editor.isRotated = Boolean(settings.rotatePreview);
    if (controls.rotatePreview) controls.rotatePreview.checked = editor.isRotated;
    applyPreviewRotation();

    var combined = []
      .concat((settings.textElements || []).map(function (data) { return Object.assign({ _type: 'text' }, data); }))
      .concat((settings.imageElements || []).map(function (data) { return Object.assign({ _type: 'image' }, data); }))
      .concat((settings.shapeElements || []).map(function (data) { return Object.assign({ _type: 'shape' }, data); }))
      .concat((settings.qrcodeElements || []).map(function (data) { return Object.assign({ _type: 'qrcode' }, data); }))
      .sort(function (a, b) { return (a.zIndex || 0) - (b.zIndex || 0); });
    combined.forEach(function (data) {
      if (data._type === 'text') restoreTextElement(data);
      else if (data._type === 'image') restoreImageElement(data);
      else if (data._type === 'shape') restoreShapeElement(data);
      else if (data._type === 'qrcode') restoreQRCodeElement(data);
    });

    updateFontFaces();
    // Text metrics need a layout pass before relative positions settle.
    requestAnimationFrame(function () {
      editor.textElements.forEach(applyTextLayout);
      updateAllRelativePositions();
      updateElementSelectorDropdown();
      editor.isLoading = false;
      syncDesignField(false);
      refreshAdhocPlaceholders();
    });
  }

  function applyPreviewRotation() {
    if (!controls.svgWrapper) return;
    controls.svgWrapper.style.transform = editor.isRotated ? 'rotate(-90deg)' : 'rotate(0deg)';
  }

  // ---------------------------------------------------------------------
  // Selection + control panels
  // ---------------------------------------------------------------------
  var selectionIndicator = null;
  function updateSelectionIndicator() {
    if (!selectionIndicator) {
      selectionIndicator = document.createElementNS(SVG_NS, 'rect');
      selectionIndicator.setAttribute('id', 'selectionIndicator');
      selectionIndicator.setAttribute('fill', 'none');
      selectionIndicator.setAttribute('stroke', '#06b6d4');
      selectionIndicator.setAttribute('stroke-width', '1');
      selectionIndicator.setAttribute('stroke-dasharray', '4 3');
      selectionIndicator.setAttribute('pointer-events', 'none');
      svg.appendChild(selectionIndicator);
    }
    var element = editor.selectedElement;
    if (!element) {
      selectionIndicator.setAttribute('visibility', 'hidden');
      return;
    }
    try {
      var bbox = element.getBBox();
      selectionIndicator.setAttribute('x', bbox.x - 2);
      selectionIndicator.setAttribute('y', bbox.y - 2);
      selectionIndicator.setAttribute('width', bbox.width + 4);
      selectionIndicator.setAttribute('height', bbox.height + 4);
      var transform = element.getAttribute('transform');
      if (transform) selectionIndicator.setAttribute('transform', transform);
      else selectionIndicator.removeAttribute('transform');
      selectionIndicator.setAttribute('visibility', 'visible');
    } catch (e) {
      selectionIndicator.setAttribute('visibility', 'hidden');
    }
  }

  function elementType(element) {
    if (element.getAttribute('data-element-type') === 'qrcode') return 'qrcode';
    var tagName = element.tagName.toLowerCase();
    if (tagName === 'text') return 'text';
    if (tagName === 'image') return 'image';
    return 'shape';
  }

  function elementDisplayName(element, index) {
    var name = element.getAttribute('data-element-name');
    if (name) return name;
    var type = elementType(element);
    if (type === 'qrcode') {
      var qrText = (element.getAttribute('data-qr-text') || 'QR code').substring(0, 20);
      return 'QR: ' + qrText;
    }
    if (type === 'text') {
      var text = (element.getAttribute('data-text') || element.textContent || 'Text').substring(0, 20);
      return 'Text: ' + text;
    }
    if (type === 'image') return 'Image ' + (index + 1);
    var shapeType = element.getAttribute('data-shape-type') || 'shape';
    return (shapeType === 'rect' ? 'Rectangle ' : 'Ellipse ') + (index + 1);
  }

  function updateElementSelectorDropdown() {
    if (!controls.elementSelector) return;
    var selectedId = editor.selectedElement ? editor.selectedElement.getAttribute('data-element-id') : '';
    controls.elementSelector.textContent = '';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— No element selected —';
    controls.elementSelector.appendChild(placeholder);
    allElements().forEach(function (element, index) {
      var option = document.createElement('option');
      option.value = element.getAttribute('data-element-id');
      option.textContent = elementDisplayName(element, index);
      if (option.value === selectedId) option.selected = true;
      controls.elementSelector.appendChild(option);
    });
  }

  function updateParentDropdown() {
    if (!controls.parentElement) return;
    var current = editor.selectedElement ? editor.selectedElement.getAttribute('data-parent') || 'label' : 'label';
    controls.parentElement.textContent = '';
    var absolute = document.createElement('option');
    absolute.value = 'label';
    absolute.textContent = 'Label (absolute)';
    controls.parentElement.appendChild(absolute);
    allElements().forEach(function (element, index) {
      if (element === editor.selectedElement) return;
      var option = document.createElement('option');
      option.value = element.getAttribute('data-element-id');
      option.textContent = elementDisplayName(element, index);
      controls.parentElement.appendChild(option);
    });
    controls.parentElement.value = current;
    if (controls.parentElement.value !== current) controls.parentElement.value = 'label';
  }

  function showPanels(type) {
    if (controls.textSettings) controls.textSettings.hidden = type !== 'text';
    if (controls.imageSettings) controls.imageSettings.hidden = type !== 'image';
    if (controls.shapeSettings) controls.shapeSettings.hidden = type !== 'shape';
    if (controls.qrcodeSettings) controls.qrcodeSettings.hidden = type !== 'qrcode';
    if (controls.positionPanel) controls.positionPanel.hidden = !type;
    if (controls.removeButton) controls.removeButton.hidden = !type;
  }

  function updateControlsForSelection() {
    var element = editor.selectedElement;
    if (!element) {
      showPanels(null);
      updateElementSelectorDropdown();
      return;
    }
    var type = editor.selectedElementType;
    showPanels(type);
    updateElementSelectorDropdown();
    updateParentDropdown();
    if (controls.anchorX) controls.anchorX.value = element.getAttribute('data-anchor-x') || 'left';
    if (controls.anchorY) controls.anchorY.value = element.getAttribute('data-anchor-y') || 'top';
    if (controls.textX) controls.textX.value = element.getAttribute('data-offset-x') || '0';
    if (controls.textY) controls.textY.value = element.getAttribute('data-offset-y') || '0';

    if (type === 'text') {
      controls.labelText.value = element.getAttribute('data-text') || '';
      controls.fontSize.value = element.getAttribute('data-font-size') || '16';
      controls.fontSizeSecondary.value = element.getAttribute('data-font-size-secondary') || '0';
      controls.fontSizeTertiary.value = element.getAttribute('data-font-size-tertiary') || '0';
      controls.lineHeight.value = element.getAttribute('data-line-height') || '1.2';
      controls.maxWidth.value = element.getAttribute('data-max-width') || '0';
      controls.maxLines.value = element.getAttribute('data-max-lines') || '0';
      controls.autoSplit.checked = element.getAttribute('data-auto-split') === '1';
      controls.balanceOrphans.checked = element.getAttribute('data-balance-orphans') === '1';
      controls.fontFamily.value = element.getAttribute('data-font-primary') || '';
      controls.fontFamilySecondary.value = element.getAttribute('data-font-secondary') || '';
      controls.fontFamilyTertiary.value = element.getAttribute('data-font-tertiary') || '';
      controls.fontFamilyFallback.value = (element.getAttribute('data-font-fallback') || 'sans-serif').split(',').pop().trim() || 'sans-serif';
      controls.fontUnicodePrimary.value = element.getAttribute('data-font-unicode-primary') || '';
      controls.fontUnicodeSecondary.value = element.getAttribute('data-font-unicode-secondary') || '';
      controls.fontUnicodeTertiary.value = element.getAttribute('data-font-unicode-tertiary') || '';
      controls.textColor.value = rgbToHex(element.style.fill || '#000000');
      var anchor = element.getAttribute('text-anchor') || 'start';
      controls.textAlign.value = anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left';
      controls.textGrowDirection.value = element.getAttribute('data-grow-direction') || 'down';
      controls.textRotation.value = element.getAttribute('data-rotation') || '0';
      controls.boldText.checked = (element.style.fontWeight || 'normal') === 'bold';
      controls.italicText.checked = (element.style.fontStyle || 'normal') === 'italic';
      controls.underlineText.checked = (element.style.textDecoration || 'none').indexOf('underline') !== -1;
    } else if (type === 'qrcode') {
      controls.qrcodeText.value = element.getAttribute('data-qr-text') || '';
      controls.qrcodeSize.value = element.getAttribute('width') || '50';
      controls.qrcodeErrorLevel.value = element.getAttribute('data-qr-error-level') || 'M';
      controls.qrcodeRotation.value = element.getAttribute('data-rotation') || '0';
    } else if (type === 'image') {
      controls.imageWidth.value = element.getAttribute('width') || '';
      controls.imageHeight.value = element.getAttribute('height') || '';
      controls.imageRotation.value = element.getAttribute('data-rotation') || '0';
    } else if (type === 'shape') {
      var shapeType = element.getAttribute('data-shape-type');
      if (shapeType === 'rect') {
        controls.shapeWidth.value = element.getAttribute('width') || '';
        controls.shapeHeight.value = element.getAttribute('height') || '';
        controls.shapeCornerRadius.value = element.getAttribute('rx') || '0';
      } else {
        controls.shapeWidth.value = (parseFloat(element.getAttribute('rx')) || 0) * 2;
        controls.shapeHeight.value = (parseFloat(element.getAttribute('ry')) || 0) * 2;
        controls.shapeCornerRadius.value = '0';
      }
      var fill = element.getAttribute('fill') || '#ffffff';
      controls.shapeFillNone.checked = fill === 'none';
      if (fill !== 'none') controls.shapeFill.value = rgbToHex(fill);
      controls.shapeStroke.value = rgbToHex(element.getAttribute('stroke') || '#000000');
      controls.shapeStrokeWidth.value = element.getAttribute('stroke-width') || '1';
      controls.shapeRotation.value = element.getAttribute('data-rotation') || '0';
    }
    updateSelectionIndicator();
  }

  function selectElement(element) {
    editor.selectedElement = element;
    editor.selectedElementType = element ? elementType(element) : null;
    updateControlsForSelection();
  }

  function clearSelection() {
    editor.selectedElement = null;
    editor.selectedElementType = null;
    updateControlsForSelection();
  }

  // ---------------------------------------------------------------------
  // Adhoc placeholder values
  // ---------------------------------------------------------------------
  function extractPlaceholders() {
    var placeholders = {};
    var scan = function (text) {
      var re = /\[@(\w+)\]/g;
      var m;
      while ((m = re.exec(text || '')) !== null) placeholders[m[1]] = true;
    };
    editor.textElements.forEach(function (element) { scan(element.getAttribute('data-text')); });
    editor.qrcodeElements.forEach(function (element) { scan(element.getAttribute('data-qr-text')); });
    return Object.keys(placeholders).sort();
  }

  function refreshAdhocPlaceholders() {
    if (!controls.adhocContainer || !controls.adhocPanel) return;
    var placeholders = extractPlaceholders();
    controls.adhocPanel.hidden = placeholders.length === 0;
    controls.adhocContainer.textContent = '';
    placeholders.forEach(function (placeholder) {
      var wrapper = document.createElement('label');
      wrapper.className = 'block';
      var caption = document.createElement('span');
      caption.className = 'block text-xs text-gray-500 mb-1';
      caption.textContent = '[@' + placeholder + ']' + (editor.tokens[placeholder] ? ' — guest: ' + editor.tokens[placeholder] : '');
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm';
      input.value = editor.adhocTokens[placeholder] || '';
      input.setAttribute('data-placeholder', placeholder);
      input.addEventListener('input', function () {
        if (input.value.trim()) editor.adhocTokens[placeholder] = input.value;
        else delete editor.adhocTokens[placeholder];
        rerenderAllTextElements();
      });
      wrapper.appendChild(caption);
      wrapper.appendChild(input);
      controls.adhocContainer.appendChild(wrapper);
    });
  }

  // ---------------------------------------------------------------------
  // Element creation from the toolbar
  // ---------------------------------------------------------------------
  function addTextBox() {
    var centerX = (parseFloat(svg.getAttribute('width')) || 0) / 2;
    var centerY = (parseFloat(svg.getAttribute('height')) || 0) / 2;
    var element = restoreTextElement({
      elementId: generateElementId('text'),
      x: String(Math.round(centerX)),
      y: String(Math.round(centerY)),
      text: 'Text ' + (editor.textElements.length + 1),
      fontSize: '16',
      autoSplit: '1',
      parent: 'label',
      anchorX: 'left',
      anchorY: 'top',
      offsetX: String(Math.round(centerX)),
      offsetY: String(Math.round(centerY))
    });
    updateFontFaces();
    selectElement(element);
    syncDesignField();
    refreshAdhocPlaceholders();
  }

  function addQRCode() {
    if (typeof window.qrcode !== 'function') {
      window.alert('The QR code library is still loading — try again in a moment.');
      return;
    }
    var labelWidth = parseFloat(svg.getAttribute('width')) || 0;
    var labelHeight = parseFloat(svg.getAttribute('height')) || 0;
    var size = Math.round(labelWidth * 0.25);
    var x = (labelWidth - size) / 2;
    var y = (labelHeight - size) / 2;
    var element = restoreQRCodeElement({
      elementId: generateElementId('qrcode'),
      x: String(x),
      y: String(y),
      size: String(size),
      qrText: '[@checkin_qrcode]',
      errorLevel: 'M',
      parent: 'label',
      anchorX: 'left',
      anchorY: 'top',
      offsetX: String(x),
      offsetY: String(y)
    });
    selectElement(element);
    syncDesignField();
    refreshAdhocPlaceholders();
  }

  function addShape(shapeType) {
    var labelWidth = parseFloat(svg.getAttribute('width')) || 0;
    var labelHeight = parseFloat(svg.getAttribute('height')) || 0;
    var data = {
      elementId: generateElementId('shape'),
      shapeType: shapeType,
      fill: '#ffffff',
      stroke: '#000000',
      strokeWidth: '1',
      parent: 'label',
      anchorX: 'left',
      anchorY: 'top'
    };
    if (shapeType === 'rect') {
      var width = Math.round(labelWidth * 0.3);
      var height = Math.round(labelHeight * 0.2);
      data.x = String(Math.round((labelWidth - width) / 2));
      data.y = String(Math.round((labelHeight - height) / 2));
      data.width = String(width);
      data.height = String(height);
      data.rx = '0';
      data.offsetX = data.x;
      data.offsetY = data.y;
    } else {
      data.cx = String(Math.round(labelWidth / 2));
      data.cy = String(Math.round(labelHeight / 2));
      data.rx = String(Math.round(labelWidth * 0.15));
      data.ry = String(Math.round(labelHeight * 0.1));
      data.offsetX = data.cx;
      data.offsetY = data.cy;
    }
    var element = restoreShapeElement(data);
    selectElement(element);
    syncDesignField();
  }

  function addImageElement(href, originalWidth, originalHeight) {
    var labelWidth = parseFloat(svg.getAttribute('width')) || 0;
    var labelHeight = parseFloat(svg.getAttribute('height')) || 0;
    var maxWidth = labelWidth * 0.4;
    var scale = originalWidth > maxWidth ? maxWidth / originalWidth : 1;
    var width = Math.round(originalWidth * scale);
    var height = Math.round(originalHeight * scale);
    var x = Math.round((labelWidth - width) / 2);
    var y = Math.round((labelHeight - height) / 2);
    var element = restoreImageElement({
      elementId: generateElementId('image'),
      x: String(x),
      y: String(y),
      width: String(width),
      height: String(height),
      href: href,
      originalWidth: String(originalWidth),
      originalHeight: String(originalHeight),
      parent: 'label',
      anchorX: 'left',
      anchorY: 'top',
      offsetX: String(x),
      offsetY: String(y)
    });
    selectElement(element);
    syncDesignField();
  }

  function loadImageFromUrl(url) {
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function () { addImageElement(url, img.naturalWidth, img.naturalHeight); };
    img.onerror = function () { window.alert('Failed to load the image. The URL may be blocked by CORS policy.'); };
    img.src = url;
  }

  function removeSelectedElement() {
    var element = editor.selectedElement;
    if (!element) return;
    var removedId = element.getAttribute('data-element-id');
    // Re-anchor children of the removed element to the label.
    allElements().forEach(function (child) {
      if (child.getAttribute('data-parent') === removedId) {
        var bounds = getElementBounds(child);
        child.setAttribute('data-parent', 'label');
        child.setAttribute('data-offset-x', bounds.x);
        child.setAttribute('data-offset-y', bounds.y);
      }
    });
    ['textElements', 'imageElements', 'shapeElements', 'qrcodeElements'].forEach(function (key) {
      editor[key] = editor[key].filter(function (item) { return item !== element; });
    });
    if (element.parentNode) element.parentNode.removeChild(element);
    clearSelection();
    syncDesignField();
    refreshAdhocPlaceholders();
  }

  // ---------------------------------------------------------------------
  // Property-change handlers
  // ---------------------------------------------------------------------
  function refreshOffsetsAfterMove(element, newX, newY) {
    var parentId = element.getAttribute('data-parent') || 'label';
    var anchorX = element.getAttribute('data-anchor-x') || 'left';
    var anchorY = element.getAttribute('data-anchor-y') || 'top';
    var basePos = calculateAbsolutePosition(parentId, anchorX, anchorY, 0, 0);
    element.setAttribute('data-offset-x', newX - basePos.x);
    element.setAttribute('data-offset-y', newY - basePos.y);
    if (controls.textX) controls.textX.value = (newX - basePos.x).toFixed(1);
    if (controls.textY) controls.textY.value = (newY - basePos.y).toFixed(1);
  }

  function repositionSelectedFromPanel() {
    var element = editor.selectedElement;
    if (!element) return;
    var parentId = controls.parentElement.value || 'label';
    var anchorX = controls.anchorX.value || 'left';
    var anchorY = controls.anchorY.value || 'top';
    var offsetX = parseFloat(controls.textX.value) || 0;
    var offsetY = parseFloat(controls.textY.value) || 0;
    element.setAttribute('data-parent', parentId);
    element.setAttribute('data-anchor-x', anchorX);
    element.setAttribute('data-anchor-y', anchorY);
    element.setAttribute('data-offset-x', offsetX);
    element.setAttribute('data-offset-y', offsetY);
    var pos = calculateAbsolutePosition(parentId, anchorX, anchorY, offsetX, offsetY);
    setElementPosition(element, pos.x, pos.y);
    updateChildPositions(element);
    updateSelectionIndicator();
    syncDesignField();
  }

  function updateSelectedTextFromPanel() {
    var element = editor.selectedElement;
    if (!element || editor.selectedElementType !== 'text') return;
    element.setAttribute('data-text', controls.labelText.value);
    element.setAttribute('data-font-size', parseInt(controls.fontSize.value, 10) || 16);
    element.setAttribute('data-font-size-secondary', parseInt(controls.fontSizeSecondary.value, 10) || 0);
    element.setAttribute('data-font-size-tertiary', parseInt(controls.fontSizeTertiary.value, 10) || 0);
    element.setAttribute('data-line-height', parseFloat(controls.lineHeight.value) || 1.2);
    element.setAttribute('data-max-width', parseInt(controls.maxWidth.value, 10) || 0);
    element.setAttribute('data-max-lines', parseInt(controls.maxLines.value, 10) || 0);
    element.setAttribute('data-auto-split', controls.autoSplit.checked ? '1' : '0');
    element.setAttribute('data-balance-orphans', controls.balanceOrphans.checked ? '1' : '0');
    element.setAttribute('data-font-primary', controls.fontFamily.value.trim());
    element.setAttribute('data-font-secondary', controls.fontFamilySecondary.value.trim());
    element.setAttribute('data-font-tertiary', controls.fontFamilyTertiary.value.trim());
    element.setAttribute('data-font-fallback', controls.fontFamilyFallback.value);
    element.setAttribute('data-font-unicode-primary', controls.fontUnicodePrimary.value.trim());
    element.setAttribute('data-font-unicode-secondary', controls.fontUnicodeSecondary.value.trim());
    element.setAttribute('data-font-unicode-tertiary', controls.fontUnicodeTertiary.value.trim());
    element.style.fill = controls.textColor.value;
    var align = controls.textAlign.value;
    element.setAttribute('text-anchor', align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start');
    element.setAttribute('data-grow-direction', controls.textGrowDirection.value);
    element.setAttribute('data-rotation', controls.textRotation.value || '0');
    element.style.fontWeight = controls.boldText.checked ? 'bold' : 'normal';
    element.style.fontStyle = controls.italicText.checked ? 'italic' : 'normal';
    element.style.textDecoration = controls.underlineText.checked ? 'underline' : 'none';

    updateFontFaces();
    applyTextLayout(element);
    var x = parseFloat(element.getAttribute('x')) || 0;
    var y = parseFloat(element.getAttribute('y')) || 0;
    applyRotationTransform(element, x, y);
    updateChildPositions(element);
    updateSelectionIndicator();
    updateElementSelectorDropdown();
    syncDesignField();
    refreshAdhocPlaceholders();
  }

  function updateSelectedQRCodeFromPanel() {
    var element = editor.selectedElement;
    if (!element || editor.selectedElementType !== 'qrcode') return;
    element.setAttribute('data-qr-text', controls.qrcodeText.value);
    element.setAttribute('data-qr-error-level', controls.qrcodeErrorLevel.value);
    var size = parseFloat(controls.qrcodeSize.value) || 50;
    element.setAttribute('width', size);
    element.setAttribute('height', size);
    element.setAttribute('data-rotation', controls.qrcodeRotation.value || '0');
    var x = parseFloat(element.getAttribute('x')) || 0;
    var y = parseFloat(element.getAttribute('y')) || 0;
    applyRotationTransform(element, x, y);
    refreshQRCodeImage(element);
    updateChildPositions(element);
    updateSelectionIndicator();
    updateElementSelectorDropdown();
    syncDesignField();
    refreshAdhocPlaceholders();
  }

  function updateSelectedImageFromPanel(changed) {
    var element = editor.selectedElement;
    if (!element || editor.selectedElementType !== 'image') return;
    var width = parseFloat(controls.imageWidth.value) || 1;
    var height = parseFloat(controls.imageHeight.value) || 1;
    if (controls.imageLockRatio.checked) {
      var originalWidth = parseFloat(element.getAttribute('data-original-width')) || width;
      var originalHeight = parseFloat(element.getAttribute('data-original-height')) || height;
      var ratio = originalHeight / originalWidth;
      if (changed === 'width') {
        height = Math.round(width * ratio);
        controls.imageHeight.value = height;
      } else if (changed === 'height') {
        width = Math.round(height / ratio);
        controls.imageWidth.value = width;
      }
    }
    element.setAttribute('width', width);
    element.setAttribute('height', height);
    element.setAttribute('data-rotation', controls.imageRotation.value || '0');
    var x = parseFloat(element.getAttribute('x')) || 0;
    var y = parseFloat(element.getAttribute('y')) || 0;
    applyRotationTransform(element, x, y);
    updateChildPositions(element);
    updateSelectionIndicator();
    syncDesignField();
  }

  function updateSelectedShapeFromPanel() {
    var element = editor.selectedElement;
    if (!element || editor.selectedElementType !== 'shape') return;
    var shapeType = element.getAttribute('data-shape-type');
    var width = parseFloat(controls.shapeWidth.value) || 1;
    var height = parseFloat(controls.shapeHeight.value) || 1;
    if (shapeType === 'rect') {
      element.setAttribute('width', width);
      element.setAttribute('height', height);
      var radius = parseFloat(controls.shapeCornerRadius.value) || 0;
      if (radius > 0) {
        element.setAttribute('rx', radius);
        element.setAttribute('ry', radius);
      } else {
        element.removeAttribute('rx');
        element.removeAttribute('ry');
      }
    } else {
      element.setAttribute('rx', width / 2);
      element.setAttribute('ry', height / 2);
    }
    element.setAttribute('fill', controls.shapeFillNone.checked ? 'none' : controls.shapeFill.value);
    element.setAttribute('stroke', controls.shapeStroke.value);
    element.setAttribute('stroke-width', controls.shapeStrokeWidth.value || '1');
    element.setAttribute('data-rotation', controls.shapeRotation.value || '0');
    var bounds = getElementBounds(element);
    if (shapeType === 'rect') applyRotationTransform(element, bounds.x, bounds.y);
    else {
      var rotation = element.getAttribute('data-rotation') || '0';
      if (parseInt(rotation, 10) === 0) element.removeAttribute('transform');
      else element.setAttribute('transform', 'rotate(' + rotation + ', ' + element.getAttribute('cx') + ', ' + element.getAttribute('cy') + ')');
    }
    updateChildPositions(element);
    updateSelectionIndicator();
    syncDesignField();
  }

  // ---------------------------------------------------------------------
  // Dragging + keyboard nudging
  // ---------------------------------------------------------------------
  function svgPointFromEvent(event) {
    var svgRect = svg.getBoundingClientRect();
    if (editor.isRotated) {
      var svgWidth = parseFloat(svg.getAttribute('width'));
      var svgHeight = parseFloat(svg.getAttribute('height'));
      var centerX = svgRect.left + svgRect.width / 2;
      var centerY = svgRect.top + svgRect.height / 2;
      var mouseRelX = event.clientX - centerX;
      var mouseRelY = event.clientY - centerY;
      // Preview is rotated -90°; rotate the pointer back by +90°.
      return { x: -mouseRelY + svgWidth / 2, y: mouseRelX + svgHeight / 2 };
    }
    return { x: event.clientX - svgRect.left, y: event.clientY - svgRect.top };
  }

  function draggableTarget(event) {
    var node = event.target;
    while (node && node !== svg) {
      if (node.getAttribute && node.getAttribute('data-element-id')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function startDrag(event) {
    var element = draggableTarget(event);
    if (!element) {
      clearSelection();
      return;
    }
    selectElement(element);
    var tagName = element.tagName.toLowerCase();
    var elementX;
    var elementY;
    if (tagName === 'ellipse' || tagName === 'circle') {
      elementX = parseFloat(element.getAttribute('cx')) || 0;
      elementY = parseFloat(element.getAttribute('cy')) || 0;
    } else {
      elementX = parseFloat(element.getAttribute('x')) || 0;
      elementY = parseFloat(element.getAttribute('y')) || 0;
    }
    var point = svgPointFromEvent(event);
    editor.dragState = {
      isDragging: true,
      moved: false,
      element: element,
      offset: { x: point.x - elementX, y: point.y - elementY }
    };
    event.preventDefault();
  }

  function moveDrag(event) {
    if (!editor.dragState.isDragging || !editor.dragState.element) return;
    editor.dragState.moved = true;
    var point = svgPointFromEvent(event);
    var newX = point.x - editor.dragState.offset.x;
    var newY = point.y - editor.dragState.offset.y;
    var element = editor.dragState.element;
    setElementPosition(element, newX, newY);
    if (element === editor.selectedElement) refreshOffsetsAfterMove(element, newX, newY);
    updateChildPositions(element);
    updateSelectionIndicator();
  }

  function endDrag() {
    if (!editor.dragState.isDragging) return;
    var moved = editor.dragState.moved;
    editor.dragState = { isDragging: false, element: null, offset: { x: 0, y: 0 } };
    if (moved) syncDesignField();
  }

  function nudgeSelected(deltaX, deltaY) {
    var element = editor.selectedElement;
    if (!element) return;
    var actualDeltaX = deltaX;
    var actualDeltaY = deltaY;
    if (editor.isRotated) {
      actualDeltaX = -deltaY;
      actualDeltaY = deltaX;
    }
    var tagName = element.tagName.toLowerCase();
    var currentX;
    var currentY;
    if (tagName === 'ellipse' || tagName === 'circle') {
      currentX = parseFloat(element.getAttribute('cx')) || 0;
      currentY = parseFloat(element.getAttribute('cy')) || 0;
    } else {
      currentX = parseFloat(element.getAttribute('x')) || 0;
      currentY = parseFloat(element.getAttribute('y')) || 0;
    }
    var newX = currentX + actualDeltaX;
    var newY = currentY + actualDeltaY;
    setElementPosition(element, newX, newY);
    refreshOffsetsAfterMove(element, newX, newY);
    updateChildPositions(element);
    updateSelectionIndicator();
    syncDesignField();
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  function on(target, type, handler) {
    if (target) target.addEventListener(type, handler);
  }

  svg.addEventListener('mousedown', startDrag);
  document.addEventListener('mousemove', moveDrag);
  document.addEventListener('mouseup', endDrag);

  document.addEventListener('keydown', function (event) {
    if (!editor.selectedElement) return;
    var tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    var step = event.shiftKey ? 10 : 1;
    var moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    var move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    nudgeSelected(move[0], move[1]);
  });

  on(controls.elementSelector, 'change', function () {
    var id = controls.elementSelector.value;
    if (!id) { clearSelection(); return; }
    var element = findElementById(id);
    if (element) selectElement(element);
  });
  on(controls.removeButton, 'click', removeSelectedElement);

  on(controls.parentElement, 'change', repositionSelectedFromPanel);
  on(controls.clearParent, 'click', function () {
    if (!editor.selectedElement) return;
    var bounds = getElementBounds(editor.selectedElement);
    controls.parentElement.value = 'label';
    controls.anchorX.value = 'left';
    controls.anchorY.value = 'top';
    controls.textX.value = bounds.x;
    controls.textY.value = bounds.y;
    repositionSelectedFromPanel();
  });
  ['anchorX', 'anchorY', 'textX', 'textY'].forEach(function (key) {
    on(controls[key], 'change', repositionSelectedFromPanel);
    on(controls[key], 'input', repositionSelectedFromPanel);
  });

  ['labelText', 'fontSize', 'fontSizeSecondary', 'fontSizeTertiary', 'lineHeight', 'maxWidth', 'maxLines',
    'fontFamily', 'fontFamilySecondary', 'fontFamilyTertiary', 'fontUnicodePrimary', 'fontUnicodeSecondary',
    'fontUnicodeTertiary', 'textColor', 'textRotation'].forEach(function (key) {
    on(controls[key], 'input', updateSelectedTextFromPanel);
  });
  ['autoSplit', 'balanceOrphans', 'fontFamilyFallback', 'textAlign', 'textGrowDirection', 'boldText', 'italicText', 'underlineText'].forEach(function (key) {
    on(controls[key], 'change', updateSelectedTextFromPanel);
  });

  ['qrcodeText', 'qrcodeSize', 'qrcodeRotation'].forEach(function (key) {
    on(controls[key], 'input', updateSelectedQRCodeFromPanel);
  });
  on(controls.qrcodeErrorLevel, 'change', updateSelectedQRCodeFromPanel);

  on(controls.imageWidth, 'input', function () { updateSelectedImageFromPanel('width'); });
  on(controls.imageHeight, 'input', function () { updateSelectedImageFromPanel('height'); });
  on(controls.imageRotation, 'input', function () { updateSelectedImageFromPanel(); });
  on(controls.imageLockRatio, 'change', function () { updateSelectedImageFromPanel('width'); });

  ['shapeWidth', 'shapeHeight', 'shapeCornerRadius', 'shapeStrokeWidth', 'shapeRotation', 'shapeFill', 'shapeStroke'].forEach(function (key) {
    on(controls[key], 'input', updateSelectedShapeFromPanel);
  });
  on(controls.shapeFillNone, 'change', updateSelectedShapeFromPanel);

  on(controls.addTextBox, 'click', addTextBox);
  on(controls.addQRCode, 'click', addQRCode);
  on(controls.addRectangle, 'click', function () { addShape('rect'); });
  on(controls.addCircle, 'click', function () { addShape('ellipse'); });
  on(controls.addImage, 'click', function () { controls.imageInput.click(); });
  on(controls.imageInput, 'change', function () {
    var file = controls.imageInput.files && controls.imageInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { loadImageFromUrl(String(reader.result)); };
    reader.readAsDataURL(file);
    controls.imageInput.value = '';
  });
  on(controls.addImageUrl, 'click', function () {
    var url = (controls.imageUrlInput.value || '').trim();
    if (!/^(https:|data:image\/)/.test(url)) {
      window.alert('Enter an https:// or data:image URL.');
      return;
    }
    loadImageFromUrl(url);
    controls.imageUrlInput.value = '';
  });

  on(controls.labelWidth, 'input', function () {
    editor.labelConfig.width = parseInt(controls.labelWidth.value, 10) || editor.labelConfig.width;
    updateSVGDimensions();
    updateAllRelativePositions();
    syncDesignField();
  });
  on(controls.labelHeight, 'input', function () {
    editor.labelConfig.height = parseInt(controls.labelHeight.value, 10) || editor.labelConfig.height;
    updateSVGDimensions();
    updateAllRelativePositions();
    syncDesignField();
  });
  on(controls.backgroundColor, 'input', function () {
    editor.labelConfig.backgroundColor = controls.backgroundColor.value;
    updateBackground();
    syncDesignField();
  });

  on(controls.rotatePreview, 'change', function () {
    editor.isRotated = controls.rotatePreview.checked;
    applyPreviewRotation();
    syncDesignField();
  });

  on(controls.resetLabel, 'click', function () {
    if (!window.confirm('Reset the design to an empty label? Unsaved elements are lost.')) return;
    applySettings({
      labelConfig: {
        width: editor.labelConfig.width,
        height: editor.labelConfig.height,
        backgroundColor: '#ffffff',
        borderColor: '#000000',
        borderWidth: 1,
        borderRadius: 0
      },
      elementIdCounter: 0
    });
    dirty = true;
    if (controls.unsavedHint) controls.unsavedHint.hidden = false;
  });

  on(controls.exportButton, 'click', function () {
    var jsonString = JSON.stringify(collectSettings(), null, 2);
    var blob = new Blob([jsonString], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'label-design-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  });

  on(controls.importButton, 'click', function () { controls.fileInput.click(); });
  on(controls.fileInput, 'change', function () {
    var file = controls.fileInput.files && controls.fileInput.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var settings = JSON.parse(String(reader.result));
        if (!settings || typeof settings !== 'object' || !settings.labelConfig) {
          throw new Error('missing labelConfig');
        }
        applySettings(settings);
        dirty = true;
        if (controls.unsavedHint) controls.unsavedHint.hidden = false;
      } catch (error) {
        window.alert('Failed to load the label design file: ' + error.message);
      }
    };
    reader.readAsText(file);
    controls.fileInput.value = '';
  });

  on(controls.saveForm, 'submit', function () {
    syncDesignField(false);
    dirty = false;
    if (controls.unsavedHint) controls.unsavedHint.hidden = true;
  });

  window.addEventListener('beforeunload', function (event) {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // Guest preview selects auto-submit; keep the Load button as fallback.
  // Browsing a list and text search are alternatives — picking one clears
  // the other so the server knows which fed the guest dropdown.
  on(controls.guestListSelect, 'change', function () {
    if (controls.guestSelect) controls.guestSelect.value = '';
    if (controls.guestSearchInput) controls.guestSearchInput.value = '';
    if (controls.guestForm) controls.guestForm.submit();
  });
  on(controls.guestSelect, 'change', function () {
    if (controls.guestForm) controls.guestForm.submit();
  });
  on(controls.guestSearchInput, 'search', function () {
    if (controls.guestSearchInput.value === '') return;
    if (controls.guestListSelect) controls.guestListSelect.value = '';
    if (controls.guestSelect) controls.guestSelect.value = '';
  });
  on(controls.guestForm, 'submit', function () {
    var query = controls.guestSearchInput ? controls.guestSearchInput.value.trim() : '';
    var previous = new URLSearchParams(window.location.search).get('q') || '';
    if (query && query !== previous) {
      // A fresh search should list matches, not keep the old guest.
      if (controls.guestListSelect) controls.guestListSelect.value = '';
      if (controls.guestSelect) controls.guestSelect.value = '';
    }
  });
  if (controls.loadGuestButton) controls.loadGuestButton.hidden = true;

  // Match the Check-in kiosk label path: rasterize the current SVG at 300 DPI,
  // encode Brother bitmap commands, then use the shared checkin_* settings to
  // send the job through WebUSB or the configured printer-server hub.
  on(controls.printButton, 'click', async function () {
    if (typeof LabelEncoder !== 'function' || typeof connectAndPrintWithBitmap !== 'function') {
      window.alert('Label printing is not loaded. Ask an administrator to approve the label printer assets.');
      return;
    }
    var clone = svg.cloneNode(true);
    var indicator = clone.querySelector('#selectionIndicator');
    if (indicator) indicator.parentNode.removeChild(indicator);
    var widthMm = editor.labelConfig.width;
    var heightMm = editor.labelConfig.height;
    var dpi = 300;
    var width = Math.round(widthMm * dpi / 25.4);
    var height = Math.round(heightMm * dpi / 25.4);
    var viewBox = (clone.getAttribute('viewBox') || '').split(/\s+/).map(Number);
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var context = canvas.getContext('2d');
    var encoder = new LabelEncoder({ width: widthMm, height: heightMm });
    var originalText = controls.printButton.textContent;
    controls.printButton.disabled = true;
    controls.printButton.textContent = 'Preparing…';
    try {
      await new Promise(function (resolve, reject) {
        try {
          encoder.svgElementToCanvas(
            clone,
            context,
            width,
            height,
            viewBox[2] || width,
            viewBox[3] || height,
            true,
            128,
            resolve,
            'floyd-steinberg'
          );
        } catch (error) {
          reject(error);
        }
      });
      var bitmapOutput = document.getElementById('bitmapOutput');
      if (!bitmapOutput) throw new Error('Print output is unavailable');
      bitmapOutput.value = encoder.encodeBitmap(canvas);
      controls.printButton.textContent = 'Sending…';
      await connectAndPrintWithBitmap(bitmapOutput);
    } catch (error) {
      console.error('Label print failed:', error);
      window.alert('Could not print label: ' + error.message);
    } finally {
      controls.printButton.disabled = false;
      controls.printButton.textContent = originalText;
    }
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  if (controls.fallback) controls.fallback.hidden = true;
  if (controls.wrapper) controls.wrapper.hidden = false;
  if (controls.exportButton) controls.exportButton.hidden = false;
  if (controls.importButton) controls.importButton.hidden = false;
  if (controls.printButton) controls.printButton.hidden = false;

  var initialSettings = {};
  try { initialSettings = JSON.parse(designField.value) || {}; } catch (e) { /* corrupted design; start blank */ }
  applySettings(initialSettings);
}());
