'use strict';
var fs = require('fs');
var path = require('path');
var SafeBuffer = require('safe-buffer');

Object.defineProperty(exports, 'commentRegex', {
  get: function getCommentRegex () {
    return /^\s*\/(?:\/|\*)[@#]\s+sourceMappingURL=data:(?:application|text)\/json;(?:charset[:=]\S+?;)?base64,(?:.*)$/mg;
  }
});

Object.defineProperty(exports, 'mapFileCommentRegex', {
  get: function getMapFileCommentRegex () {
    // Matches sourceMappingURL in either // or /* comment styles.
    return /(?:\/\/[@#][ \t]+sourceMappingURL=([^\s'"`]+?)[ \t]*$)|(?:\/\*[@#][ \t]+sourceMappingURL=([^\*]+?)[ \t]*(?:\*\/){1}[ \t]*$)/mg;
  }
});


function decodeBase64(base64) {
  return SafeBuffer.Buffer.from(base64, 'base64').toString();
}

function stripComment(sm) {
  return sm.split(',').pop();
}

function readFromFileMap(sm, dir) {
  // NOTE: this will only work on the server since it attempts to read the map file

  var r = exports.mapFileCommentRegex.exec(sm);

  // for some odd reason //# .. captures in 1 and /* .. */ in 2
  var filename = r[1] || r[2];
  var filepath = path.resolve(dir, filename);

  try {
    return fs.readFileSync(filepath, 'utf8');
  } catch (e) {
    throw new Error('An error occurred while trying to read the map file at ' + filepath + '\n' + e);
  }
}

function Converter (sm, opts) {
  opts = opts || {};

  if (opts.isFileComment) sm = readFromFileMap(sm, opts.commentFileDir);
  if (opts.hasComment) sm = stripComment(sm);
  if (opts.isEncoded) sm = decodeBase64(sm);
  if (opts.isJSON || opts.isEncoded) sm = JSON.parse(sm);

  this.sourcemap = sm;
}

Converter.prototype.toJSON = function (space) {
  return JSON.stringify(this.sourcemap, null, space);
};

Converter.prototype.toBase64 = function () {
  var json = this.toJSON();
  return SafeBuffer.Buffer.from(json, 'utf8').toString('base64');
};

Converter.prototype.toComment = function (options) {
  var base64 = this.toBase64();
  var data = 'sourceMappingURL=data:application/json;charset=utf-8;base64,' + base64;
  return options && options.multiline ? '/*# ' + data + ' */' : '//# ' + data;
};

// returns copy instead of original
Converter.prototype.toObject = function () {
  return JSON.parse(this.toJSON());
};

Converter.prototype.addProperty = function (key, value) {
  if (this.sourcemap.hasOwnProperty(key)) throw new Error('property "' + key + '" already exists on the sourcemap, use set property instead');
  return this.setProperty(key, value);
};

Converter.prototype.setProperty = function (key, value) {
  this.sourcemap[key] = value;
  return this;
};

Converter.prototype.getProperty = function (key) {
  return this.sourcemap[key];
};

exports.fromObject = function (obj) {
  return new Converter(obj);
};

exports.fromJSON = function (json) {
  return new Converter(json, { isJSON: true });
};

exports.fromBase64 = function (base64) {
  return new Converter(base64, { isEncoded: true });
};

exports.fromComment = function (comment) {
  comment = comment
    .replace(/^\/\*/g, '//')
    .replace(/\*\/$/g, '');

  return new Converter(comment, { isEncoded: true, hasComment: true });
};

exports.fromMapFileComment = function (comment, dir) {
  return new Converter(comment, { commentFileDir: dir, isFileComment: true, isJSON: true });
};

// Finds last sourcemap comment in file or returns null if none was found
exports.fromSource = function (content) {
  var comments = exports.getComments(content, exports.commentRegex);
  if (!comments.length) return null;
  return exports.fromComment(comments.pop().value);
};

// Finds last sourcemap comment in file or returns null if none was found
exports.fromMapFileSource = function (content, dir) {
  var comments = exports.getComments(content, exports.mapFileCommentRegex);
  if (!comments.length) return null;
  return exports.fromMapFileComment(comments.pop().value, dir);
};

exports.removeComments = function (src) {
  var comments = exports.getComments(src, exports.commentRegex);
  return removeRanges(src, comments);
};

exports.removeMapFileComments = function (src) {
  var comments = exports.getComments(src, exports.mapFileCommentRegex);
  return removeRanges(src, comments);
};

exports.generateMapFileComment = function (file, options) {
  var data = 'sourceMappingURL=' + file;
  return options && options.multiline ? '/*# ' + data + ' */' : '//# ' + data;
};

function removeRanges(str, ranges) {
  var result = "";
  var lastEnd = 0;
  for (var i = 0; i < ranges.length; i++) {
    result += str.slice(lastEnd, ranges.start);
  }
  return result + str.slice(lastEnd);
}

exports.getComments = getComments;
function getComments(code, filter) {
  var tplStack = [];
  var tplIndex = -1;
  var comments = [];

  var i = 0;
  while (i < code.length) {
    var ch = code[i];
    switch (ch) {
      // Parse comments
      case '/':
        var next = code[i + 1];
        if (next === '/') {
          // This is a single line comment, which ends with a newline character
          i = indexOf2(code, '\n', '\r', start + 2);

          var value = code.slice(start, i);
          if (filter.test(value)) {
            comments.push({ start: start, end: i, value: value });
          }

          // Skip \n or \r
          i++;
        } else if (next === '*') {
          // This is a single line comment, which ends with /*
          i = indexOf(code, '*/', start + 2);
          // Skip */
          i += 2;

          var value = code.slice(start, i);
          if (filter.test(value)) {
            comments.push({ start: start, end: i, value: value });
          }
        } else {
          i++;
        }
        break;

      // Skip strings with " and '. Look for the next matching quote but,
      // if it is escaped, skip it and continue looking.
      case '"':
      case '\'':
        // Search the first unescaped closing quote
        do {
          i = indexOf(code, ch, i + 1);
        } while (i !== Infinity && isEscaped(code, i));
        i++;
        break;

      // Parse template literals (start reading the code from the ` case)
      // When there is a `, go to the first unescaped occurrence of ` or ${.
      // If there is `, the template doesn't have any substitution and we
      // can skip it. If there is ${, we store in tplStack[tplIndex] the
      // number of unmatched {. When we parse } and there are 0 unmatched {,
      // it means that we finished parsing the substitution and we are inside
      // the template's string contents again. We look for the next unescaped
      // ` or ${ and start the process again.
      case '{':
        if (tplIndex > -1) tplStack[tplIndex]++;
        i++;
        break;
      case '}':
        i++;
        if (tplIndex === -1 || --tplStack[tplIndex--] !== 0) break;
        /* falls through */
      case '`':
        do {
          i = indexOf2(code, '`', '${', i + 1);
        } while (i !== Infinity && isEscaped(code, i));
        i++; // skip ` or $

        if (code[i - 1] === '`') break; // no substitutions

        i++; // skip {
        tplStack[++tplIndex] = 1; // 1 and not 0 because we already parsed {
        break;
      
      default:
        i++;
    }
  }

  return comments;
};


function isEscaped(code, index) {
  var escaped = false;
  while (code[--index] === '\\') escaped = !escaped;
  return escaped;
}

// This is the same as String#indexOf, but returns Infinity instead of -1.
// This helps avoiding infinite loops, because the index never decreases.
// In case of unmatched characters (e.g. unclosed strings), it will simply
// stop looping through the code.
function indexOf(str, search, start) {
  var i = str.indexOf(search, start);
  return i === -1 ? Infinity : i;
}

function indexOf2(str, a, b, start) {
  return Math.min(indexOf(str, a, start), indexOf(str, b, start));
}
