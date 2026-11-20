/* qrcode.js - Minimal ES5 QR Code generator
 * Renders monochrome QR codes to a <canvas> or via HTML table.
 * Based on public-domain QR reference implementations. No dependencies.
 * Supports version auto-selection (1-10), mode: byte, EC level: M.
 */
(function (global) {
    'use strict';

    // Galois field tables
    var EXP_TABLE = new Array(256), LOG_TABLE = new Array(256);
    (function () {
        for (var i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
        for (var i = 8; i < 256; i++) {
            EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
        }
        for (var i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]] = i;
    })();
    function gexp(n) { while (n < 0) n += 255; while (n >= 256) n -= 255; return EXP_TABLE[n]; }
    function glog(n) { if (n < 1) throw new Error('glog(' + n + ')'); return LOG_TABLE[n]; }

    function Polynomial(num, shift) {
        if (num.length == undefined) throw new Error(num.length + '/' + shift);
        var offset = 0;
        while (offset < num.length && num[offset] == 0) offset++;
        this.num = new Array(num.length - offset + shift);
        for (var i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset];
    }
    Polynomial.prototype.get = function (i) { return this.num[i]; };
    Polynomial.prototype.getLength = function () { return this.num.length; };
    Polynomial.prototype.multiply = function (e) {
        var num = new Array(this.getLength() + e.getLength() - 1);
        for (var i = 0; i < this.getLength(); i++) {
            for (var j = 0; j < e.getLength(); j++) {
                num[i + j] ^= gexp(glog(this.get(i)) + glog(e.get(j)));
            }
        }
        return new Polynomial(num, 0);
    };
    Polynomial.prototype.mod = function (e) {
        if (this.getLength() - e.getLength() < 0) return this;
        var ratio = glog(this.get(0)) - glog(e.get(0));
        var num = new Array(this.getLength());
        for (var i = 0; i < this.getLength(); i++) num[i] = this.get(i);
        for (var i = 0; i < e.getLength(); i++) num[i] ^= gexp(glog(e.get(i)) + ratio);
        return new Polynomial(num, 0).mod(e);
    };

    var QRUtil = {
        PATTERN_POSITION_TABLE: [
            [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
            [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54]
        ],
        G15: (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0),
        G18: (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0),
        G15_MASK: (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1),
        getBCHTypeInfo: function (data) {
            var d = data << 10;
            while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15) >= 0) {
                d ^= (QRUtil.G15 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15)));
            }
            return ((data << 10) | d) ^ QRUtil.G15_MASK;
        },
        getBCHTypeNumber: function (data) {
            var d = data << 12;
            while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G18) >= 0) {
                d ^= (QRUtil.G18 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G18)));
            }
            return (data << 12) | d;
        },
        getBCHDigit: function (data) { var d = 0; while (data != 0) { d++; data >>>= 1; } return d; },
        getPatternPosition: function (typeNumber) { return QRUtil.PATTERN_POSITION_TABLE[typeNumber - 1]; },
        getMask: function (maskPattern, i, j) {
            switch (maskPattern) {
                case 0: return (i + j) % 2 == 0;
                case 1: return i % 2 == 0;
                case 2: return j % 3 == 0;
                case 3: return (i + j) % 3 == 0;
                case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 == 0;
                case 5: return (i * j) % 2 + (i * j) % 3 == 0;
                case 6: return ((i * j) % 2 + (i * j) % 3) % 2 == 0;
                case 7: return ((i * j) % 3 + (i + j) % 2) % 2 == 0;
                default: throw new Error('bad maskPattern:' + maskPattern);
            }
        },
        getErrorCorrectPolynomial: function (ecLength) {
            var a = new Polynomial([1], 0);
            for (var i = 0; i < ecLength; i++) a = a.multiply(new Polynomial([1, gexp(i)], 0));
            return a;
        },
        getLostPoint: function (qrCode) {
            var moduleCount = qrCode.getModuleCount();
            var lostPoint = 0;
            for (var row = 0; row < moduleCount; row++) {
                for (var col = 0; col < moduleCount; col++) {
                    var sameCount = 0;
                    var dark = qrCode.isDark(row, col);
                    for (var r = -1; r <= 1; r++) {
                        if (row + r < 0 || moduleCount <= row + r) continue;
                        for (var c = -1; c <= 1; c++) {
                            if (col + c < 0 || moduleCount <= col + c) continue;
                            if (r == 0 && c == 0) continue;
                            if (dark == qrCode.isDark(row + r, col + c)) sameCount++;
                        }
                    }
                    if (sameCount > 5) lostPoint += (3 + sameCount - 5);
                }
            }
            return lostPoint;
        }
    };

    // Block info table for EC level M, versions 1-10 (covers typical URL sizes)
    // [totalCount, dataCount, ecCount] per block group
    var RS_BLOCK_M = [
        [[1, 26, 16]], [[1, 44, 28]], [[1, 70, 44]], [[2, 50, 32]],
        [[2, 67, 43]], [[4, 43, 27]], [[4, 49, 31]], [[2, 60, 38], [2, 61, 39]],
        [[3, 58, 36], [2, 59, 37]], [[4, 69, 43], [1, 70, 44]]
    ];

    function QRCodeModel(typeNumber, data) {
        this.typeNumber = typeNumber;
        this.modules = null;
        this.moduleCount = 0;
        this.dataList = [data];
    }

    QRCodeModel.prototype = {
        getModuleCount: function () { return this.moduleCount; },
        isDark: function (r, c) { return this.modules[r][c]; },
        make: function () { this.makeImpl(false, this.getBestMaskPattern()); },
        makeImpl: function (test, maskPattern) {
            this.moduleCount = this.typeNumber * 4 + 17;
            this.modules = new Array(this.moduleCount);
            for (var r = 0; r < this.moduleCount; r++) {
                this.modules[r] = new Array(this.moduleCount);
                for (var c = 0; c < this.moduleCount; c++) this.modules[r][c] = null;
            }
            this.setupPositionProbePattern(0, 0);
            this.setupPositionProbePattern(this.moduleCount - 7, 0);
            this.setupPositionProbePattern(0, this.moduleCount - 7);
            this.setupPositionAdjustPattern();
            this.setupTimingPattern();
            this.setupTypeInfo(test, maskPattern);
            if (this.typeNumber >= 7) this.setupTypeNumber(test);
            if (!this._data) this._data = QRCodeModel.createData(this.typeNumber, this.dataList);
            this.mapData(this._data, maskPattern);
        },
        setupPositionProbePattern: function (row, col) {
            for (var r = -1; r <= 7; r++) {
                if (row + r <= -1 || this.moduleCount <= row + r) continue;
                for (var c = -1; c <= 7; c++) {
                    if (col + c <= -1 || this.moduleCount <= col + c) continue;
                    this.modules[row + r][col + c] =
                        (0 <= r && r <= 6 && (c == 0 || c == 6)) ||
                        (0 <= c && c <= 6 && (r == 0 || r == 6)) ||
                        (2 <= r && r <= 4 && 2 <= c && c <= 4);
                }
            }
        },
        getBestMaskPattern: function () {
            var minLost = 0, pattern = 0;
            for (var i = 0; i < 8; i++) {
                this.makeImpl(true, i);
                var lost = QRUtil.getLostPoint(this);
                if (i == 0 || minLost > lost) { minLost = lost; pattern = i; }
            }
            return pattern;
        },
        setupTimingPattern: function () {
            for (var r = 8; r < this.moduleCount - 8; r++) {
                if (this.modules[r][6] != null) continue;
                this.modules[r][6] = (r % 2 == 0);
            }
            for (var c = 8; c < this.moduleCount - 8; c++) {
                if (this.modules[6][c] != null) continue;
                this.modules[6][c] = (c % 2 == 0);
            }
        },
        setupPositionAdjustPattern: function () {
            var pos = QRUtil.getPatternPosition(this.typeNumber);
            for (var i = 0; i < pos.length; i++) {
                for (var j = 0; j < pos.length; j++) {
                    var row = pos[i], col = pos[j];
                    if (this.modules[row][col] != null) continue;
                    for (var r = -2; r <= 2; r++) {
                        for (var c = -2; c <= 2; c++) {
                            this.modules[row + r][col + c] =
                                (r == -2 || r == 2 || c == -2 || c == 2 || (r == 0 && c == 0));
                        }
                    }
                }
            }
        },
        setupTypeNumber: function (test) {
            var bits = QRUtil.getBCHTypeNumber(this.typeNumber);
            for (var i = 0; i < 18; i++) {
                var mod = (!test && ((bits >> i) & 1) == 1);
                this.modules[Math.floor(i / 3)][i % 3 + this.moduleCount - 8 - 3] = mod;
                this.modules[i % 3 + this.moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
            }
        },
        setupTypeInfo: function (test, maskPattern) {
            // EC level M = 0b00
            var data = (0 << 3) | maskPattern;
            var bits = QRUtil.getBCHTypeInfo(data);
            for (var i = 0; i < 15; i++) {
                var mod = (!test && ((bits >> i) & 1) == 1);
                if (i < 6) this.modules[i][8] = mod;
                else if (i < 8) this.modules[i + 1][8] = mod;
                else this.modules[this.moduleCount - 15 + i][8] = mod;
            }
            for (var i = 0; i < 15; i++) {
                var mod = (!test && ((bits >> i) & 1) == 1);
                if (i < 8) this.modules[8][this.moduleCount - i - 1] = mod;
                else if (i < 9) this.modules[8][15 - i - 1 + 1] = mod;
                else this.modules[8][15 - i - 1] = mod;
            }
            this.modules[this.moduleCount - 8][8] = (!test);
        },
        mapData: function (data, maskPattern) {
            var inc = -1, row = this.moduleCount - 1, bitIndex = 7, byteIndex = 0;
            for (var col = this.moduleCount - 1; col > 0; col -= 2) {
                if (col == 6) col--;
                while (true) {
                    for (var c = 0; c < 2; c++) {
                        if (this.modules[row][col - c] == null) {
                            var dark = false;
                            if (byteIndex < data.length) dark = (((data[byteIndex] >>> bitIndex) & 1) == 1);
                            var mask = QRUtil.getMask(maskPattern, row, col - c);
                            if (mask) dark = !dark;
                            this.modules[row][col - c] = dark;
                            bitIndex--;
                            if (bitIndex == -1) { byteIndex++; bitIndex = 7; }
                        }
                    }
                    row += inc;
                    if (row < 0 || this.moduleCount <= row) { row -= inc; inc = -inc; break; }
                }
            }
        }
    };

    QRCodeModel.createData = function (typeNumber, dataList) {
        var rsBlocks = QRCodeModel.getRSBlocks(typeNumber);
        var buffer = new BitBuffer();
        for (var i = 0; i < dataList.length; i++) {
            var data = dataList[i];
            buffer.put(4, 4); // byte mode
            buffer.put(data.length, typeNumber < 10 ? 8 : 16);
            data.write(buffer);
        }
        var totalDataCount = 0;
        for (var i = 0; i < rsBlocks.length; i++) totalDataCount += rsBlocks[i].dataCount;
        if (buffer.getLengthInBits() > totalDataCount * 8) {
            throw new Error('code length overflow. (' + buffer.getLengthInBits() + '>' + totalDataCount * 8 + ')');
        }
        if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) buffer.put(0, 4);
        while (buffer.getLengthInBits() % 8 != 0) buffer.putBit(false);
        while (true) {
            if (buffer.getLengthInBits() >= totalDataCount * 8) break;
            buffer.put(0xEC, 8);
            if (buffer.getLengthInBits() >= totalDataCount * 8) break;
            buffer.put(0x11, 8);
        }
        return QRCodeModel.createBytes(buffer, rsBlocks);
    };

    QRCodeModel.createBytes = function (buffer, rsBlocks) {
        var offset = 0, maxDcCount = 0, maxEcCount = 0;
        var dcdata = new Array(rsBlocks.length), ecdata = new Array(rsBlocks.length);
        for (var r = 0; r < rsBlocks.length; r++) {
            var dcCount = rsBlocks[r].dataCount;
            var ecCount = rsBlocks[r].totalCount - dcCount;
            maxDcCount = Math.max(maxDcCount, dcCount);
            maxEcCount = Math.max(maxEcCount, ecCount);
            dcdata[r] = new Array(dcCount);
            for (var i = 0; i < dcdata[r].length; i++) dcdata[r][i] = 0xff & buffer.buffer[i + offset];
            offset += dcCount;
            var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
            var rawPoly = new Polynomial(dcdata[r], rsPoly.getLength() - 1);
            var modPoly = rawPoly.mod(rsPoly);
            ecdata[r] = new Array(rsPoly.getLength() - 1);
            for (var i = 0; i < ecdata[r].length; i++) {
                var idx = i + modPoly.getLength() - ecdata[r].length;
                ecdata[r][i] = (idx >= 0) ? modPoly.get(idx) : 0;
            }
        }
        var totalCodeCount = 0;
        for (var i = 0; i < rsBlocks.length; i++) totalCodeCount += rsBlocks[i].totalCount;
        var data = new Array(totalCodeCount), index = 0;
        for (var i = 0; i < maxDcCount; i++) {
            for (var r = 0; r < rsBlocks.length; r++) if (i < dcdata[r].length) data[index++] = dcdata[r][i];
        }
        for (var i = 0; i < maxEcCount; i++) {
            for (var r = 0; r < rsBlocks.length; r++) if (i < ecdata[r].length) data[index++] = ecdata[r][i];
        }
        return data;
    };

    QRCodeModel.getRSBlocks = function (typeNumber) {
        var rsBlock = RS_BLOCK_M[typeNumber - 1];
        if (!rsBlock) throw new Error('bad rs block @' + typeNumber);
        var length = 0;
        for (var i = 0; i < rsBlock.length; i++) length += rsBlock[i][0];
        var list = new Array(length);
        var k = 0;
        for (var i = 0; i < rsBlock.length; i++) {
            for (var j = 0; j < rsBlock[i][0]; j++) {
                list[k++] = { totalCount: rsBlock[i][1], dataCount: rsBlock[i][2] };
            }
        }
        return list;
    };

    function QRByte(data) {
        this.mode = 4;
        this.data = data;
        // UTF-8 encode
        var buf = [];
        for (var i = 0; i < data.length; i++) {
            var c = data.charCodeAt(i);
            if (c < 0x80) buf.push(c);
            else if (c < 0x800) { buf.push(0xc0 | (c >> 6)); buf.push(0x80 | (c & 0x3f)); }
            else { buf.push(0xe0 | (c >> 12)); buf.push(0x80 | ((c >> 6) & 0x3f)); buf.push(0x80 | (c & 0x3f)); }
        }
        this.parsedData = buf;
        this.length = buf.length;
    }
    QRByte.prototype.write = function (buffer) {
        for (var i = 0; i < this.parsedData.length; i++) buffer.put(this.parsedData[i], 8);
    };

    function BitBuffer() { this.buffer = []; this.length = 0; }
    BitBuffer.prototype.getLengthInBits = function () { return this.length; };
    BitBuffer.prototype.putBit = function (bit) {
        var bufIndex = Math.floor(this.length / 8);
        if (this.buffer.length <= bufIndex) this.buffer.push(0);
        if (bit) this.buffer[bufIndex] |= (0x80 >>> (this.length % 8));
        this.length++;
    };
    BitBuffer.prototype.put = function (num, length) {
        for (var i = 0; i < length; i++) this.putBit(((num >>> (length - i - 1)) & 1) == 1);
    };

    // Data capacity for byte mode, EC level M (bytes)
    var DATA_CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];

    function pickVersion(data) {
        var len = new QRByte(data).length;
        for (var i = 0; i < DATA_CAPACITY_M.length; i++) {
            if (len <= DATA_CAPACITY_M[i]) return i + 1;
        }
        throw new Error('data too long for QR');
    }

    // Public API
    function makeQR(text) {
        var version = pickVersion(text);
        var qr = new QRCodeModel(version, new QRByte(text));
        qr.make();
        return qr;
    }

    function renderToContainer(container, text, opts) {
        opts = opts || {};
        var size = opts.size || 320;
        var bg = opts.background || '#ffffff';
        var fg = opts.foreground || '#000000';
        var margin = opts.margin == null ? 2 : opts.margin;

        // Clear
        while (container.firstChild) container.removeChild(container.firstChild);

        var qr = makeQR(text);
        var count = qr.getModuleCount();
        var totalModules = count + margin * 2;
        var scale = Math.floor(size / totalModules);
        if (scale < 1) scale = 1;

        // Prefer canvas, fall back to table if unavailable
        var canvas = document.createElement('canvas');
        if (canvas.getContext) {
            canvas.width = totalModules * scale;
            canvas.height = totalModules * scale;
            canvas.style.width = (totalModules * scale) + 'px';
            canvas.style.height = (totalModules * scale) + 'px';
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = fg;
            for (var r = 0; r < count; r++) {
                for (var c = 0; c < count; c++) {
                    if (qr.isDark(r, c)) {
                        ctx.fillRect((c + margin) * scale, (r + margin) * scale, scale, scale);
                    }
                }
            }
            container.appendChild(canvas);
        } else {
            // HTML table fallback
            var tbl = document.createElement('table');
            tbl.style.borderCollapse = 'collapse';
            tbl.style.background = bg;
            for (var r = 0; r < count; r++) {
                var tr = document.createElement('tr');
                for (var c = 0; c < count; c++) {
                    var td = document.createElement('td');
                    td.style.width = scale + 'px';
                    td.style.height = scale + 'px';
                    td.style.background = qr.isDark(r, c) ? fg : bg;
                    td.style.padding = '0';
                    tr.appendChild(td);
                }
                tbl.appendChild(tr);
            }
            container.appendChild(tbl);
        }
    }

    global.QRCode = { render: renderToContainer };
})(window);
