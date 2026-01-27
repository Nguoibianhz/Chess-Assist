(function() {
    'use strict';


    let config = {
        enabled: true,
        autoSuggest: false,
        autoMove: false,
        engineModel: 'stockfish10',
        playerColor: 'auto',
        numArrows: 1,
        thinkTime: 2,
        bestColor: "#00ff41",
        secondaryColor: "#1e90ff",
        opacity: 0.78,
        hash: 1024,
        debugMode: false,
        uiMinimized: false,
        localServerUrl: 'http://127.0.0.1:5050',
        localTimeoutMs: 20000,
        automatic: false,
        automaticColor: 'auto',
        automaticMinTime: 1,
        automaticMaxTime: 3,
        statusEnabled: false,
        statusThinkTime: 3
    };

    const LOCAL_ENGINE_MODEL = 'stockfish17_local';


    const ENGINE_URLS = {
        stockfish10: 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js',
        stockfish17: 'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js'
    };

    let board = null;
    let arrows = [];
    let menu = null;
    let statusText = null;
    let lastFEN = '';
    let lastTurn = '';


    let evaler = null;
    let isCalculating = false;
    let engineReady = false;
    let bestMoves = [];
    let analysisRequestId = 0;
    let localEngineOnline = false;
    let localHealthLastCheck = 0;
    let lastBoardKey = '';
    let automaticInterval = null;
    let statusLastFEN = '';
    let statusPendingFEN = '';
    let statusDebounceTimer = null;
    let statusPollInterval = null;
    let statusBar = null;
    let statusDrag = false;
    let statusDragOffsetX = 0;
    let statusDragOffsetY = 0;
    let statusOnly = false;
    let statusEvalTurn = 'w';
    let statusScoreCp = null;
    let statusScoreMate = null;


    const dbg = (...args) => {
        if (config.debugMode) console.log('[HieuChess]', ...args);
    };


    const pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    function isLocalEngine() {
        return config.engineModel === LOCAL_ENGINE_MODEL;
    }

    function normalizeTurnValue(turn) {
        if (turn === 1 || turn === 'w' || turn === 'white') return 'white';
        if (turn === 2 || turn === 'b' || turn === 'black') return 'black';
        return '';
    }

    function getTurnFromAPI() {
        const gameAPI = getGameAPI();
        if (gameAPI && typeof gameAPI.getTurn === 'function') {
            return normalizeTurnValue(gameAPI.getTurn());
        }
        return '';
    }

    function getTurnFromFENString(fen) {
        if (!fen) return '';
        const parts = fen.split(' ');
        if (parts.length > 1) {
            if (parts[1] === 'w') return 'white';
            if (parts[1] === 'b') return 'black';
        }
        return '';
    }

    function normalizeServerUrl(url) {
        const raw = (url || config.localServerUrl || '').trim();
        return raw.replace(/\/+$/, '');
    }

    function httpRequestJson(method, url, payload, timeoutMs) {
        const body = payload ? JSON.stringify(payload) : null;
        const hasGM = typeof GM_xmlhttpRequest === 'function';

        return new Promise((resolve, reject) => {
            if (hasGM) {
                GM_xmlhttpRequest({
                    method,
                    url,
                    data: body || undefined,
                    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
                    timeout: timeoutMs,
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300) {
                            try {
                                const data = res.responseText ? JSON.parse(res.responseText) : {};
                                resolve(data);
                            } catch (err) {
                                reject(err);
                            }
                        } else {
                            reject(new Error(`HTTP ${res.status}`));
                        }
                    },
                    onerror: () => reject(new Error('Network error')),
                    ontimeout: () => reject(new Error('Timeout'))
                });
                return;
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            fetch(url, {
                method,
                headers: payload ? { 'Content-Type': 'application/json' } : undefined,
                body: body || undefined,
                signal: controller.signal
            }).then(async (res) => {
                const text = await res.text();
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                return text ? JSON.parse(text) : {};
            }).then(resolve).catch(reject).finally(() => {
                clearTimeout(timer);
            });
        });
    }


    function getGameAPI() {
        return pageWindow.game;
    }


    function initEngine() {
        dbg("🔧 Initializing Stockfish engine...");
        updateStatus("⏳ Đang load engine...", "#ffaa00");

        if (isLocalEngine()) {
            initLocalEngine();
            return;
        }

        const engineUrl = ENGINE_URLS[config.engineModel];
        if (!engineUrl) {
            updateStatus("❌ Engine URL không hợp lệ", "#ff5555");
            return;
        }
        dbg("Engine URL:", engineUrl);

        if (typeof Worker !== 'undefined') {
            try {
                const workerCode = `importScripts('${engineUrl}');`;
                const blob = new Blob([workerCode], { type: 'application/javascript' });
                const workerUrl = URL.createObjectURL(blob);
                evaler = new Worker(workerUrl);

                dbg("✅ Worker created");
                setupEngineHandlers();

            } catch(e) {
                dbg("Worker failed, trying direct load:", e);
                loadDirectEngine(engineUrl);
            }
        } else {
            dbg("No Worker support, loading direct");
            loadDirectEngine(engineUrl);
        }
    }

    function loadDirectEngine(url) {
        const script = document.createElement('script');
        script.src = url;
        script.onload = () => {
            setTimeout(() => {
                if (typeof STOCKFISH === 'function') {
                    evaler = STOCKFISH();
                    dbg("✅ Direct STOCKFISH loaded");
                    setupEngineHandlers();
                } else {
                    console.error("❌ STOCKFISH not found");
                    updateStatus("Lỗi load engine", "#ff5555");
                }
            }, 500);
        };
        script.onerror = () => {
            console.error("❌ Failed to load Stockfish script");
            updateStatus("Không load được Stockfish", "#ff5555");
        };
        document.head.appendChild(script);
    }

    function updateLocalEngineStatus(text, color = "#88ff88") {
        const statusEl = document.getElementById('localEngineStatus');
        if (statusEl) {
            statusEl.textContent = text;
            statusEl.style.color = color;
        }
    }

    function initLocalEngine(showPopup = false) {
        evaler = null;
        engineReady = false;
        localEngineOnline = false;

        const now = Date.now();
        if (now - localHealthLastCheck < 500) {
            return;
        }
        localHealthLastCheck = now;

        const baseUrl = normalizeServerUrl(config.localServerUrl);
        if (!baseUrl) {
            updateLocalEngineStatus("Invalid URL", "#ff5555");
            updateStatus("❌ Local engine URL invalid", "#ff5555");
            return;
        }
        const healthUrl = `${baseUrl}/health`;

        updateLocalEngineStatus("Checking local server...", "#ffaa00");
        updateStatus("⏳ Local engine: checking...", "#ffaa00");

        httpRequestJson('GET', healthUrl, null, config.localTimeoutMs)
            .then((data) => {
                if (data && data.ok) {
                    localEngineOnline = true;
                    engineReady = true;
                    updateLocalEngineStatus(`Online (${data.engine || 'stockfish'})`, "#00ff9d");
                    updateStatus("✅ Local Stockfish ready!", "#00ff9d");
                } else {
                    localEngineOnline = false;
                    updateLocalEngineStatus("Offline", "#ff5555");
                    updateStatus("❌ Local engine offline", "#ff5555");
                    if (showPopup) showLocalEnginePopup();
                }
            })
            .catch((err) => {
                localEngineOnline = false;
                dbg("Local engine health check failed:", err);
                updateLocalEngineStatus("Offline", "#ff5555");
                updateStatus("❌ Local engine offline", "#ff5555");
                if (showPopup) showLocalEnginePopup();
            });
    }

    function setupEngineHandlers() {
        if (!evaler) {
            console.error("No evaler!");
            return;
        }

        evaler.onmessage = function(event) {
            let line;

            if (event && typeof event === "object") {
                line = event.data;
            } else {
                line = event;
            }

            if (!line) return;

            dbg("Engine:", line);


            const cp_index = line.indexOf("cp");
            const nodes_index = line.indexOf("nodes");
            const upper_index = line.indexOf("upperbound");
            const mate_index = line.indexOf("mate");

            if (cp_index >= 0 || mate_index >= 0) {
                const scoreCpMatch = line.match(/score cp (-?\d+)/);
                const scoreMateMatch = line.match(/score mate (-?\d+)/);
                if (statusOnly) {
                    if (scoreMateMatch) {
                        statusScoreMate = parseInt(scoreMateMatch[1], 10);
                        statusScoreCp = null;
                    } else if (scoreCpMatch) {
                        statusScoreCp = parseInt(scoreCpMatch[1], 10);
                        statusScoreMate = null;
                    }
                }

                if (!statusOnly) {
                    let score;

                    if (upper_index >= 0) {
                        score = line.substr(cp_index+3, upper_index-cp_index-3);
                    } else {
                        score = line.substr(cp_index+3, nodes_index-cp_index-3);
                    }

                    if (mate_index >= 0) {
                        let moves_to_mate = line.substr(mate_index+5, nodes_index-mate_index-5);
                        moves_to_mate = parseInt(moves_to_mate);

                        if (moves_to_mate > 0) {
                            updateStatus(`Score: +M${Math.abs(moves_to_mate)}`, "#00ff9d");
                        } else if (moves_to_mate < 0) {
                            updateStatus(`Score: -M${Math.abs(moves_to_mate)}`, "#ff5555");
                        }
                    } else {
                        score = parseFloat(score) / 100;
                        const scoreStr = score > 0 ? `+${score.toFixed(2)}` : score.toFixed(2);
                        updateStatus(`Score: ${scoreStr}`, "#88ff88");
                    }
                }
            }

            const depth_index = line.indexOf("depth");
            const seldepth_index = line.indexOf("seldepth");
            if (!statusOnly && depth_index >= 0 && seldepth_index >= 0) {
                const depth = line.substr(depth_index+6, seldepth_index-depth_index-6);
                updateStatus(`Depth: ${depth.trim()}`, "#88ff88");
            }

            const multipv_index = line.indexOf("multipv");
            const pv_index = line.indexOf(" pv ");

            if (!statusOnly && multipv_index >= 0 && pv_index >= 0) {
                const pvNumMatch = line.match(/multipv (\d+)/);
                if (pvNumMatch) {
                    const pvNum = parseInt(pvNumMatch[1]) - 1;
                    const pvMoves = line.substr(pv_index + 4).trim().split(' ');

                    if (!bestMoves[pvNum]) bestMoves[pvNum] = {};
                    bestMoves[pvNum].moves = pvMoves;

                    dbg(`?? Saved PV ${pvNum}:`, pvMoves[0]);
                }
            }

            const res = line.substr(0, 8);

            if (res === "bestmove") {
                if (statusOnly) {
                    isCalculating = false;
                    statusOnly = false;
                    const hasStatusScore = typeof statusScoreMate === 'number' || typeof statusScoreCp === 'number';
                    if (hasStatusScore) {
                        updateEvalBar(statusScoreCp, statusScoreMate);
                    }
                    statusScoreCp = null;
                    statusScoreMate = null;
                    flushPendingStatus();
                    return;
                }
                const parts = line.split(' ');
                const bestmove = parts[1] || '';

                dbg("✅ Best move:", bestmove);

                if (bestmove && bestmove !== "(none)" && bestmove.length >= 4) {
                    if (!bestMoves[0]) bestMoves[0] = {};
                    if (!bestMoves[0].moves || bestMoves[0].moves.length === 0) {
                        bestMoves[0].moves = [bestmove];
                    }
                    drawBestMoveArrows();


                    if (shouldAutoMove() && bestMoves.length > 0) {
                        const move = bestMoves[0].moves[0];
                        const from = move.slice(0, 2);
                        const to = move.slice(2, 4);
                        const promotion = getPromotionChar(move, from, to);

                        dbg("🤖 Auto moving:", from, "->", to);
                        setTimeout(() => makeAutoMove(from, to, promotion), 500);
                    }

                    isCalculating = false;
                    updateStatus("✅ Tính xong!", "#00ff9d");
                    flushPendingStatus();
                } else {
                    updateStatus("Không có nước đi", "#ffaa00");
                    isCalculating = false;
                    flushPendingStatus();
                }
            }
        };


        evaler.postMessage('uci');
        setTimeout(() => {
            evaler.postMessage(`setoption name Hash value ${config.hash}`);
            evaler.postMessage(`setoption name MultiPV value ${config.numArrows}`);
            evaler.postMessage('ucinewgame');
            engineReady = true;
            updateStatus(`✅ ${config.engineModel} sẵn sàng!`, "#00ff9d");
            dbg("✅ Engine ready!");
        }, 100);
    }


    function calculatePosition(fen, options = {}) {
        if (statusOnly) {
            statusOnly = false;
            if (evaler && isCalculating) {
                evaler.postMessage('stop');
            }
        }

        const multipv = options.multipv || config.numArrows;
        const movetimeMs = options.movetimeMs || (config.thinkTime * 1000);

        if (isLocalEngine()) {
            calculatePositionLocal(fen, multipv, movetimeMs);
            return true;
        }

        if (!evaler) {
            updateStatus("Engine chưa khởi tạo", "#ff5555");
            return true;
        }

        if (!engineReady) {
            updateStatus("Engine chưa sẵn sàng, đợi...", "#ffaa00");
            setTimeout(() => calculatePosition(fen, options), 500);
            return true;
        }

        if (isCalculating) {
            evaler.postMessage('stop');
        }

        isCalculating = true;
        bestMoves = [];

        updateStatus("⚡ Đang tính...", "#88ff88");


        dbg("🔄 Sending FEN to engine:", fen);
        const fenParts = fen.split(' ');
        dbg("🔄 Turn in FEN:", fenParts[1] === 'w' ? 'WHITE' : 'BLACK');

        evaler.postMessage(`setoption name Hash value ${config.hash}`);
        evaler.postMessage(`setoption name MultiPV value ${multipv}`);
        evaler.postMessage(`position fen ${fen}`);
        evaler.postMessage(`go movetime ${movetimeMs}`);
        return true;
    }

    function calculatePositionLocal(fen, multipv, movetimeMs, options = {}) {
        if (statusOnly) {
            statusOnly = false;
        }

        if (!engineReady) {
            updateStatus("Local engine chưa sẵn sàng, đợi...", "#ffaa00");
            initLocalEngine();
            setTimeout(() => calculatePositionLocal(fen, multipv, movetimeMs), 500);
            return;
        }

        analysisRequestId += 1;
        const requestId = analysisRequestId;

        isCalculating = true;
        bestMoves = [];

        updateStatus("⚡ Đang tính (local)...", "#88ff88");
        dbg("🔄 Sending FEN to local engine:", fen);

        const baseUrl = normalizeServerUrl(config.localServerUrl);
        const analyzeUrl = `${baseUrl}/analyze`;
        const payload = {
            fen,
            movetimeMs: Math.max(50, Math.round(movetimeMs)),
            multipv: Math.max(1, multipv),
            hash: Math.max(16, config.hash)
        };

        httpRequestJson('POST', analyzeUrl, payload, config.localTimeoutMs)
            .then((result) => {
                if (requestId !== analysisRequestId) return;
                if (!result || !result.ok) {
                    throw new Error(result && result.error ? result.error : 'Local engine error');
                }

                const info = applyLocalAnalysis(result);
                drawBestMoveArrows();
                updateLocalAnalysisStatus(info);

                if (shouldAutoMove() && bestMoves.length > 0 && bestMoves[0].moves && bestMoves[0].moves.length > 0) {
                    const move = bestMoves[0].moves[0];
                    const from = move.slice(0, 2);
                    const to = move.slice(2, 4);
                    const promotion = getPromotionChar(move, from, to);
                    setTimeout(() => makeAutoMove(from, to, promotion), 200);
                }
            })
            .catch((err) => {
                if (requestId !== analysisRequestId) return;
                const message = err && err.message ? err.message : '';
                if (message.includes('HTTP 429') || message.includes('busy')) {
                    const retryCount = options.retry || 0;
                    if (retryCount < 4) {
                        const delay = 150 + retryCount * 150;
                        setTimeout(() => {
                            calculatePositionLocal(fen, multipv, movetimeMs, { ...options, retry: retryCount + 1 });
                        }, delay);
                        return;
                    }
                }
                if (err && (err.message === 'Timeout' || err.name === 'AbortError')) {
                    const retryCount = options.retry || 0;
                    if (retryCount < 1) {
                        setTimeout(() => {
                            calculatePositionLocal(fen, multipv, movetimeMs, { ...options, retry: retryCount + 1 });
                        }, 200);
                        return;
                    }
                }
                dbg("Local engine error:", err);
                localEngineOnline = false;
                engineReady = false;
                updateLocalEngineStatus("Offline", "#ff5555");
                updateStatus("❌ Local engine lỗi/kết nối", "#ff5555");
                if (config.automatic) {
                    automaticWaitingForMove = false;
                    automaticLastFEN = '';
                    automaticLastActionAt = 0;
                }
            })
            .finally(() => {
                if (requestId === analysisRequestId) {
                    isCalculating = false;
                    flushPendingStatus();
                }
            });
    }

    function applyLocalAnalysis(result) {
        const pvs = Array.isArray(result.pvs) ? result.pvs : [];
        bestMoves = [];

        pvs.forEach((pv) => {
            const idx = (pv.multipv || 1) - 1;
            bestMoves[idx] = {
                moves: Array.isArray(pv.moves) ? pv.moves : []
            };
            if (typeof pv.scoreCp === 'number') bestMoves[idx].scoreCp = pv.scoreCp;
            if (typeof pv.scoreMate === 'number') bestMoves[idx].scoreMate = pv.scoreMate;
            if (typeof pv.depth === 'number') bestMoves[idx].depth = pv.depth;
        });

        if ((!bestMoves[0] || !bestMoves[0].moves || bestMoves[0].moves.length === 0) && result.bestmove) {
            bestMoves[0] = { moves: [result.bestmove] };
        }

        const top = bestMoves[0] || {};
        const depth = result.depth || top.depth;
        const scoreStr = formatScoreFromPV(top);

        return { depth, scoreStr };
    }

    function updateLocalAnalysisStatus(info) {
        if (!info) {
            updateStatus("✅ Tính xong!", "#00ff9d");
            return;
        }

        const depth = info.depth;
        const scoreStr = info.scoreStr;

        if (depth && scoreStr) {
            updateStatus(`✅ Tính xong! (Depth ${depth} | Score ${scoreStr})`, "#00ff9d");
        } else if (depth) {
            updateStatus(`✅ Tính xong! (Depth ${depth})`, "#00ff9d");
        } else if (scoreStr) {
            updateStatus(`✅ Tính xong! (Score ${scoreStr})`, "#00ff9d");
        } else {
            updateStatus("✅ Tính xong!", "#00ff9d");
        }
    }

    function drawBestMoveArrows() {
        clearArrows();

        dbg("📍 Drawing arrows, bestMoves:", bestMoves);

        if (!bestMoves || bestMoves.length === 0) {
            updateStatus("Không có nước đi", "#ffaa00");
            return;
        }

        board = findBoardElement();
        if (!board) {
            updateStatus("Mất board element", "#ff5555");
            return;
        }

        let drawnCount = 0;

        bestMoves.slice(0, config.numArrows).forEach((pv, i) => {
            if (!pv || !pv.moves || pv.moves.length === 0) {
                dbg(`❌ PV ${i} invalid:`, pv);
                return;
            }

            const move = pv.moves[0];
            if (!move || move.length < 4) {
                dbg(`❌ Move ${i} invalid:`, move);
                return;
            }

            const from = move.slice(0, 2);
            const to = move.slice(2, 4);
            const color = i === 0 ? config.bestColor : config.secondaryColor;
            const opacity = i === 0 ? config.opacity : config.opacity * 0.6;

            dbg(`✅ Drawing arrow ${i}: ${from} -> ${to}`);
            drawArrow(from, to, color, opacity, 999 - i);
            drawnCount++;
        });

        updateStatus(`✅ Vẽ ${drawnCount} mũi tên`, "#00ff9d");
    }


    function formatScoreFromPV(pv) {
        if (!pv) return '';
        if (typeof pv.scoreMate === 'number') {
            const mate = pv.scoreMate;
            const sign = mate > 0 ? '+' : '-';
            return `${sign}M${Math.abs(mate)}`;
        }
        if (typeof pv.scoreCp === 'number') {
            const score = pv.scoreCp / 100;
            const sign = score > 0 ? '+' : '';
            return `${sign}${score.toFixed(2)}`;
        }
        return '';
    }

    function getPromotionChar(move, from, to) {
        if (move && move.length > 4) {
            return move[4].toLowerCase();
        }
        if (!from || !to) return null;
        const fromRank = parseInt(from[1], 10);
        const toRank = parseInt(to[1], 10);
        const isWhitePromo = fromRank === 7 && toRank === 8;
        const isBlackPromo = fromRank === 2 && toRank === 1;
        if (isWhitePromo || isBlackPromo) {

            return 'q';
        }
        return null;
    }

    function dispatchPointerClick(target, x, y) {
        if (!target) return false;
        const eventOptions = {
            bubbles: true,
            cancelable: true,
            view: pageWindow,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            button: 0,
            buttons: 1
        };

        target.dispatchEvent(new PointerEvent('pointerdown', { ...eventOptions, pointerId: 1, pointerType: 'mouse' }));
        target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
        target.dispatchEvent(new PointerEvent('pointerup', { ...eventOptions, pointerId: 1, pointerType: 'mouse' }));
        target.dispatchEvent(new MouseEvent('mouseup', eventOptions));
        target.dispatchEvent(new MouseEvent('click', eventOptions));
        return true;
    }

    function clickElementCenter(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const target = document.elementFromPoint(x, y) || el;
        return dispatchPointerClick(target, x, y);
    }

    function clickPromotionPiece(promotion, fromSquare, toSquare) {
        if (!promotion) return false;
        const promo = promotion.toLowerCase();
        const pieceName = promo === 'q' ? 'queen' : promo === 'r' ? 'rook' : promo === 'b' ? 'bishop' : 'knight';
        const fromRank = parseInt(fromSquare[1], 10);
        const toRank = parseInt(toSquare[1], 10);
        const color = (fromRank === 7 && toRank === 8) ? 'w' : (fromRank === 2 && toRank === 1) ? 'b' : '';
        const colorName = color === 'w' ? 'white' : color === 'b' ? 'black' : '';

        const selectors = [];

        if (location.host.includes('chess.com')) {
            const colors = color ? [color] : ['w', 'b'];
            for (const c of colors) {
                selectors.push(
                    `.promotion-window--visible .promotion-piece.${c}${promo}`,
                    `.promotion-window .promotion-piece.${c}${promo}`,
                    `.promotion-piece.${c}${promo}`,
                    `.promotion-piece[data-piece="${c}${promo}"]`
                );
            }
            selectors.push(
                `.promotion-piece.${pieceName}`,
                `.promotion-piece.${colorName}.${pieceName}`,
                `.promotion-window .${pieceName}`,
                `.promotion-piece [class*="${pieceName}"]`
            );
        } else if (location.host.includes('lichess.org')) {
            selectors.push(
                `.promotion piece.${pieceName}`,
                `.promotion .${pieceName}`,
                `piece.${pieceName}`,
                `.promotion-piece.${pieceName}`,
                `.promotion-piece .${pieceName}`
            );
        }

        selectors.push(
            `.promotion [data-piece="${promo}"]`,
            `.promotion [data-piece="${color}${promo}"]`,
            `.promotion-window [data-piece="${color}${promo}"]`,
            `.promotion [class*="${pieceName}"]`,
            `.promotion-window [class*="${pieceName}"]`
        );

        for (const selector of selectors) {
            const promoBtn = document.querySelector(selector);
            if (promoBtn) {
                const clicked = clickElementCenter(promoBtn);
                dbg("✅ Clicked promotion:", selector, "via pointer=", clicked);
                return true;
            }
        }

        if (location.host.includes('chess.com')) {
            const promoEls = [...document.querySelectorAll('.promotion-piece')];
            if (promoEls.length > 0) {
                const match = promoEls.find(el => el.classList.contains(`${color}${promo}`))
                    || promoEls.find(el => el.classList.contains(`w${promo}`))
                    || promoEls.find(el => el.classList.contains(`b${promo}`));
                if (match) {
                    const clicked = clickElementCenter(match);
                    dbg("✅ Clicked promotion by class fallback:", match.className, "via pointer=", clicked);
                    return true;
                }
            }
        }

        if (location.host.includes('lichess.org')) {
            const key = promo.toLowerCase();
            const keyEvent = new KeyboardEvent('keydown', { key });
            document.dispatchEvent(keyEvent);
            return true;
        }

        return false;
    }

    function squareToCoords(square) {

        const file = square.charCodeAt(0) - 97;
        const rank = parseInt(square[1]) - 1;
        return { file, rank };
    }

    function clickSquare(square) {
        const boardEl = findBoardElement();
        if (!boardEl) {
            console.error("❌ Board not found for click");
            return false;
        }

        const rect = boardEl.getBoundingClientRect();
        const squareSize = rect.width / 8;

        const coords = squareToCoords(square);


        const isFlipped = boardEl.classList.contains('flipped');

        let x, y;
        if (isFlipped) {
            x = rect.left + (7 - coords.file + 0.5) * squareSize;
            y = rect.top + (coords.rank + 0.5) * squareSize;
        } else {
            x = rect.left + (coords.file + 0.5) * squareSize;
            y = rect.top + (7 - coords.rank + 0.5) * squareSize;
        }

        dbg(`📍 Clicking ${square} at (${x.toFixed(0)}, ${y.toFixed(0)}), flipped=${isFlipped}`);


        const targetEl = document.elementFromPoint(x, y) || boardEl;


        const eventOptions = {
            bubbles: true,
            cancelable: true,
            view: pageWindow,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            button: 0,
            buttons: 1
        };


        const pointerDown = new PointerEvent('pointerdown', { ...eventOptions, pointerId: 1, pointerType: 'mouse' });
        const mouseDown = new MouseEvent('mousedown', eventOptions);
        const pointerUp = new PointerEvent('pointerup', { ...eventOptions, pointerId: 1, pointerType: 'mouse' });
        const mouseUp = new MouseEvent('mouseup', eventOptions);
        const click = new MouseEvent('click', eventOptions);

        targetEl.dispatchEvent(pointerDown);
        targetEl.dispatchEvent(mouseDown);
        targetEl.dispatchEvent(pointerUp);
        targetEl.dispatchEvent(mouseUp);
        targetEl.dispatchEvent(click);

        return true;
    }




    function makeAutoMove(fromSquare, toSquare, promotion = null) {
        dbg("🤖 Attempting auto move:", fromSquare, "->", toSquare);
        updateStatus(`🤖 Moving ${fromSquare}-${toSquare}...`, "#ffaa00");

        if (!board) {
            board = findBoardElement();
            if (!board) {
                updateStatus("❌ Board not found", "#ff5555");
                return false;
            }
        }

        try {

            dbg("📍 Step 1: Clicking source square", fromSquare);
            clickSquare(fromSquare);


            setTimeout(() => {
                dbg("📍 Step 2: Clicking destination square", toSquare);
                clickSquare(toSquare);


                const resolvedPromotion = promotion ? promotion.toLowerCase() : getPromotionChar('', fromSquare, toSquare);
                if (resolvedPromotion) {
                    const tryClickPromotion = (attempt) => {
                        dbg("📍 Step 3: Handling promotion", resolvedPromotion, "attempt", attempt + 1);
                        const clicked = clickPromotionPiece(resolvedPromotion, fromSquare, toSquare);
                        if (!clicked && attempt < 5) {
                            setTimeout(() => tryClickPromotion(attempt + 1), 150);
                        } else if (!clicked) {
                            dbg("⚠️ Promotion UI not found, fallback to default");
                        }
                    };
                    setTimeout(() => tryClickPromotion(0), 200);
                }

                updateStatus(`✅ Moved ${fromSquare}-${toSquare}`, "#00ff9d");
            }, 100);

            return true;
        } catch(e) {
            console.error("❌ Auto move failed:", e);
            updateStatus("❌ Auto move thất bại", "#ff5555");
            return false;
        }
    }

    function shouldAutoMove() {
        return config.autoMove && !config.automatic && !automaticWaitingForMove;
    }


    GM_addStyle(`
        #hieu-chess-menu {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: rgba(30, 30, 40, 0.95);
            color: #e0e0ff;
            padding: 12px 16px;
            border-radius: 12px;
            box-shadow: 0 4px 30px rgba(0,0,0,0.7);
            z-index: 999999;
            font-family: 'Segoe UI', Arial, sans-serif;
            user-select: none;
            max-width: 520px;
            border: 1px solid #555;
            transition: all 0.3s ease;
        }
        #hieu-chess-menu.minimized {
            max-width: 200px;
            padding: 8px 12px;
        }
        #hieu-chess-menu.minimized .hieu-content {
            display: none;
        }
        #hieu-chess-menu.minimized #status {
            display: none;
        }
        .hieu-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 10px;
        }
        #hieu-chess-menu.minimized .hieu-header {
            margin-bottom: 0;
        }
        #hieu-chess-menu h3 {
            margin: 0;
            font-size: 15px;
            color: #00ff9d;
            font-weight: 600;
            cursor: move;
            flex: 1;
        }
        .hieu-minimize-btn {
            background: rgba(255,255,255,0.1);
            border: 1px solid #666;
            color: #fff;
            width: 28px;
            height: 28px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
        }
        .hieu-minimize-btn:hover {
            background: rgba(255,255,255,0.2);
        }
        .hieu-content {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
        }
        .hieu-section {
            background: rgba(20, 20, 30, 0.5);
            padding: 10px;
            border-radius: 8px;
            border-left: 3px solid #00ff9d;
        }
        .hieu-section.full-width {
            grid-column: 1 / -1;
        }
        .hieu-section-title {
            font-size: 11px;
            color: #00ff9d;
            font-weight: bold;
            margin-bottom: 8px;
            text-transform: uppercase;
        }
        .hieu-row {
            display: flex;
            align-items: center;
            margin: 6px 0;
            font-size: 12px;
        }
        .hieu-row label {
            flex: 1;
            margin-right: 6px;
            white-space: nowrap;
        }
        .hieu-row select {
            flex: 1.5;
            padding: 3px 6px;
            background: rgba(50, 50, 60, 0.8);
            border: 1px solid #666;
            color: #fff;
            border-radius: 4px;
            font-size: 11px;
        }
        .hieu-row input[type="text"] {
            flex: 1.5;
            padding: 3px 6px;
            background: rgba(50, 50, 60, 0.8);
            border: 1px solid #666;
            color: #fff;
            border-radius: 4px;
            font-size: 11px;
        }
        .hieu-row input[type="range"] {
            flex: 1.5;
            height: 4px;
        }
        .hieu-row input[type="number"] {
            width: 50px;
            padding: 3px;
            background: rgba(50, 50, 60, 0.8);
            border: 1px solid #666;
            color: #fff;
            border-radius: 4px;
            text-align: center;
            font-size: 11px;
        }
        .hieu-row input[type="color"] {
            width: 32px;
            height: 20px;
            padding: 0;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }
        .hieu-row input[type="checkbox"] {
            width: 16px;
            height: 16px;
            cursor: pointer;
        }
        #status {
            margin-top: 10px;
            font-size: 11px;
            text-align: center;
            color: #88ff88;
            padding: 6px;
            background: rgba(0, 0, 0, 0.3);
            border-radius: 6px;
            min-height: 18px;
        }
        button.hieu-btn {
            background: linear-gradient(135deg, #0066cc, #0088ff);
            color: white;
            border: none;
            padding: 6px 10px;
            border-radius: 6px;
            cursor: pointer;
            margin: 3px 2px;
            font-weight: 500;
            transition: all 0.2s;
            font-size: 11px;
            width: 100%;
        }
        button.hieu-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(0, 102, 204, 0.4);
        }
        button.hieu-btn.active {
            background: linear-gradient(135deg, #00cc44, #00ff66);
        }
        button.hieu-btn:disabled {
            background: #555;
            cursor: not-allowed;
            opacity: 0.5;
        }
        .hieu-btn-group {
            display: flex;
            gap: 6px;
            margin: 6px 0;
        }
        .hieu-btn-small {
            font-size: 10px;
            padding: 5px 8px;
        }
        .hieu-inline-controls {
            display: flex;
            align-items: center;
            gap: 6px;
        }
        button.hieu-btn-mini {
            width: auto;
            padding: 2px 6px;
            font-size: 10px;
            line-height: 1;
            border-radius: 4px;
        }
        .hieu-inline-row {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }
        .hieu-inline-row .hieu-row {
            flex: 1;
            min-width: 100px;
        }
        #hieu-eval-bar {
            position: fixed;
            right: 20px;
            bottom: 120px;
            width: 26px;
            height: 240px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0,0,0,0.45);
            border: 1px solid #444;
            border-radius: 8px;
            padding: 6px;
            z-index: 1000000;
            cursor: move;
        }
        #hieu-eval-track {
            position: relative;
            width: 100%;
            height: 100%;
            background: #111;
            border: 1px solid #333;
            border-radius: 6px;
            overflow: hidden;
        }
        #hieu-eval-fill {
            position: absolute;
            bottom: 0;
            width: 100%;
            height: 50%;
            background: #f2f2f2;
            transition: height 0.35s ease;
        }
        .hieu-footer {
            margin-top: 10px;
            padding-top: 8px;
            border-top: 1px solid #2a2a3a;
            text-align: center;
            font-size: 11px;
            color: #b8c0ff;
        }
        .hieu-footer a {
            color: #3aa0ff;
            text-decoration: none;
            font-weight: 600;
        }
        .hieu-footer a:hover {
            text-decoration: underline;
        }
        .hieu-footer .hieu-bio-btn {
            margin-top: 6px;
            display: inline-block;
            background: rgba(58, 160, 255, 0.2);
            border: 1px solid rgba(58, 160, 255, 0.6);
            color: #3aa0ff;
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 10px;
            cursor: pointer;
        }
        .hieu-footer .hieu-bio-btn:hover {
            background: rgba(58, 160, 255, 0.35);
        }
        #hieu-local-popup {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.5);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 1000001;
        }
        .hieu-popup-card {
            width: 320px;
            background: #141822;
            border: 1px solid #2f3b52;
            border-radius: 12px;
            padding: 14px 16px 12px;
            color: #e6ecff;
            box-shadow: 0 12px 30px rgba(0,0,0,0.4);
            position: relative;
        }
        .hieu-popup-title {
            font-weight: 700;
            font-size: 13px;
            margin-bottom: 6px;
            color: #7fc0ff;
        }
        .hieu-popup-text {
            font-size: 11px;
            line-height: 1.4;
            color: #c7d0ee;
            margin-bottom: 10px;
        }
        .hieu-popup-actions {
            display: flex;
            gap: 8px;
        }
        .hieu-popup-btn {
            flex: 1;
            background: rgba(58, 160, 255, 0.15);
            border: 1px solid rgba(58, 160, 255, 0.5);
            color: #7fc0ff;
            padding: 6px 8px;
            border-radius: 8px;
            font-size: 11px;
            cursor: pointer;
        }
        .hieu-popup-btn:hover {
            background: rgba(58, 160, 255, 0.3);
        }
        .hieu-popup-close {
            position: absolute;
            top: 8px;
            right: 8px;
            width: 22px;
            height: 22px;
            border-radius: 50%;
            border: 1px solid #3a4a66;
            color: #9fb7d8;
            background: transparent;
            cursor: pointer;
            font-size: 12px;
        }
        .hieu-popup-close:hover {
            background: rgba(255,255,255,0.08);
        }
    `);

    function createStatusBar() {
        if (statusBar) return statusBar;
        const existing = document.getElementById('hieu-eval-bar');
        if (existing) {
            statusBar = existing;
            return statusBar;
        }
        statusBar = document.createElement('div');
        statusBar.id = 'hieu-eval-bar';
        statusBar.style.display = config.statusEnabled ? 'flex' : 'none';
        statusBar.innerHTML = `
            <div id="hieu-eval-track">
                <div id="hieu-eval-fill"></div>
            </div>
        `;
        document.body.appendChild(statusBar);

        statusBar.addEventListener('mousedown', e => {
            statusDrag = true;
            const rect = statusBar.getBoundingClientRect();
            statusDragOffsetX = e.clientX - rect.left;
            statusDragOffsetY = e.clientY - rect.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', e => {
            if (!statusDrag) return;
            statusBar.style.left = `${Math.max(0, e.clientX - statusDragOffsetX)}px`;
            statusBar.style.top = `${Math.max(0, e.clientY - statusDragOffsetY)}px`;
            statusBar.style.right = 'auto';
            statusBar.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', () => {
            statusDrag = false;
        });

        return statusBar;
    }

    function showLocalEnginePopup() {
        const popup = document.getElementById('hieu-local-popup');
        if (!popup) return;
        popup.style.display = 'flex';
    }

    function hideLocalEnginePopup() {
        const popup = document.getElementById('hieu-local-popup');
        if (!popup) return;
        popup.style.display = 'none';
    }

    function openLocalEngineLink() {
        const url = 'https://nguyenmanhhieu.info.vn/enginechess';
        window.open(url, '_blank', 'noopener');
        hideLocalEnginePopup();
    }

    function copyLocalEngineLink() {
        const url = 'https://nguyenmanhhieu.info.vn/enginechess';
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).finally(() => hideLocalEnginePopup());
        } else {
            const input = document.createElement('input');
            input.value = url;
            document.body.appendChild(input);
            input.select();
            try { document.execCommand('copy'); } catch (e) {}
            input.remove();
            hideLocalEnginePopup();
        }
    }



    function createMenu() {
        menu = document.createElement('div');
        menu.id = 'hieu-chess-menu';
        if (config.uiMinimized) menu.classList.add('minimized');

        menu.innerHTML = `
            <div class="hieu-header">
                <h3>♟️ Hiếu Chess.com Assist V2.5</h3>
                <button id="minimizeBtn" class="hieu-minimize-btn" title="Thu nhỏ/Phóng to">
                    ${config.uiMinimized ? '⬜' : '➖'}
                </button>
            </div>

            <div class="hieu-content">
                <div class="hieu-section">
                    <div class="hieu-section-title">⚙️ Điều khiển</div>
                    <div class="hieu-btn-group">
                        <button id="toggleBtn" class="hieu-btn ${config.enabled ? 'active' : ''}">
                            ${config.enabled ? '✓ ON' : '⏸ OFF'}
                        </button>
                        <button id="calcBtn" class="hieu-btn">🔄 Tính</button>
                    </div>
                    <div class="hieu-row">
                        <label>Status:</label>
                        <input type="checkbox" id="statusEnabled" ${config.statusEnabled ? 'checked' : ''}>
                    </div>
                    <button id="clearArrowsBtn" class="hieu-btn hieu-btn-small">🗑️ Xóa mũi tên</button>
                </div>

                <div class="hieu-section">
                    <div class="hieu-section-title">🤖 Auto Mode</div>
                    <div class="hieu-row">
                        <label>Màu:</label>
                        <select id="playerColor">
                            <option value="auto" ${config.playerColor === 'auto' ? 'selected' : ''}>🔄 Tự động</option>
                            <option value="white" ${config.playerColor === 'white' ? 'selected' : ''}>⬜ Trắng</option>
                            <option value="black" ${config.playerColor === 'black' ? 'selected' : ''}>⬛ Đen</option>
                        </select>
                    </div>
                    <div class="hieu-row">
                        <label>Suggest:</label>
                        <input type="checkbox" id="autoSuggest" ${config.autoSuggest ? 'checked' : ''}>
                    </div>
                    <div class="hieu-row">
                        <label>Move:</label>
                        <input type="checkbox" id="autoMove" ${config.autoMove ? 'checked' : ''}>
                    </div>
                    <div class="hieu-row" style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #444;">
                        <label>🎯 Automatic:</label>
                        <div class="hieu-inline-controls">
                            <input type="checkbox" id="automaticMode" ${config.automatic ? 'checked' : ''}>
                            <button id="forceAutoMove" class="hieu-btn hieu-btn-mini" title="Ép đi ngay">⚡</button>
                        </div>
                    </div>
                    <div id="automaticSettings" style="display: ${config.automatic ? 'block' : 'none'}; margin-left: 10px; padding: 8px; background: rgba(0,100,50,0.2); border-radius: 6px; margin-top: 6px;">
                        <div class="hieu-row">
                            <label>Màu của bạn:</label>
                            <select id="automaticColor">
                                <option value="auto" ${config.automaticColor === 'auto' ? 'selected' : ''}>🔄 Tự động</option>
                                <option value="white" ${config.automaticColor === 'white' ? 'selected' : ''}>⬜ Trắng</option>
                                <option value="black" ${config.automaticColor === 'black' ? 'selected' : ''}>⬛ Đen</option>
                            </select>
                        </div>
                        <div class="hieu-row">
                            <label>Time (s):</label>
                            <input type="number" id="automaticMinTime" min="0.5" max="30" step="0.5" value="${config.automaticMinTime}" style="width:40px;">
                            <span>-</span>
                            <input type="number" id="automaticMaxTime" min="0.5" max="30" step="0.5" value="${config.automaticMaxTime}" style="width:40px;">
                        </div>
                        <div id="automaticStatus" style="font-size: 10px; color: #00ff9d; margin-top: 4px;">⏸ Đang chờ...</div>
                    </div>
                </div>

                <div class="hieu-section">
                    <div class="hieu-section-title">⚡ Engine</div>
                    <div class="hieu-row">
                        <label>Model:</label>
                        <select id="engineModel">
                            <option value="stockfish10" ${config.engineModel === 'stockfish10' ? 'selected' : ''}>SF 10</option>
                            <option value="stockfish17" ${config.engineModel === 'stockfish17' ? 'selected' : ''}>SF 17</option>
                            <option value="stockfish17_local" ${config.engineModel === 'stockfish17_local' ? 'selected' : ''}>SF 17.1 (Local)</option>
                        </select>
                    </div>
                    <div id="localEngineSettings" style="display: ${config.engineModel === 'stockfish17_local' ? 'block' : 'none'}; margin-top: 6px;">
                        <div class="hieu-row">
                            <label>Local API:</label>
                            <input type="text" id="localServerUrl" value="${config.localServerUrl}">
                        </div>
                        <div id="localEngineStatus" style="font-size: 10px; color: #88ff88; margin-top: 4px;">Status: checking...</div>
                    </div>
                    <div class="hieu-row">
                        <label>Time:</label>
                        <input type="number" id="thinkTime" min="0.5" max="30" step="0.5" value="${config.thinkTime}">s
                    </div>
                    <div class="hieu-row">
                        <label>Hash:</label>
                        <input type="number" id="hash" min="64" max="1024" step="64" value="${config.hash}">MB
                    </div>
                    <div class="hieu-row">
                        <label>Arrows:</label>
                        <input type="range" id="numArrows" min="1" max="5" value="${config.numArrows}">
                        <span id="numArrowsVal">${config.numArrows}</span>
                    </div>
                </div>

                <div class="hieu-section">
                    <div class="hieu-section-title">🎨 Giao diện</div>
                    <div class="hieu-row">
                        <label>Best:</label>
                        <input type="color" id="bestColor" value="${config.bestColor}">
                    </div>
                    <div class="hieu-row">
                        <label>Alt:</label>
                        <input type="color" id="secondaryColor" value="${config.secondaryColor}">
                    </div>
                    <div class="hieu-row">
                        <label>Opacity:</label>
                        <input type="range" id="opacity" min="0.3" max="1" step="0.05" value="${config.opacity}">
                    </div>
                    <div class="hieu-row">
                        <label>Debug:</label>
                        <input type="checkbox" id="debugMode" ${config.debugMode ? 'checked' : ''}>
                    </div>
                </div>
            </div>

            <div id="status">Đang khởi động...</div>
            <div class="hieu-footer">
                © <a href="#" id="hieu-author-link">NguyenManhHieu</a> · Dev By <a href="#" id="hieu-dev-link">HiếuDz</a>
                <div>
                    <button class="hieu-bio-btn" id="hieu-bio-btn">Bio Here</button>
                </div>
            </div>

        `;

        document.body.appendChild(menu);

        const popup = document.createElement('div');
        popup.id = 'hieu-local-popup';
        popup.innerHTML = `
            <div class="hieu-popup-card">
                <button class="hieu-popup-close" id="hieu-popup-close">✕</button>
                <div class="hieu-popup-title">Local engine chưa online</div>
                <div class="hieu-popup-text">
                    Bạn cần tải LocalEngine hoặc chạy engine nếu đã tải.
                </div>
                <div class="hieu-popup-actions">
                    <button class="hieu-popup-btn" id="hieu-popup-copy">Copy link</button>
                    <button class="hieu-popup-btn" id="hieu-popup-open">Mở link</button>
                </div>
            </div>
        `;
        document.body.appendChild(popup);


        let isDragging = false;
        let currentX = 0, currentY = 0, initialX = 0, initialY = 0;
        const header = menu.querySelector('.hieu-header');

        header.addEventListener('mousedown', e => {
            if (e.target.classList.contains('hieu-minimize-btn')) return;
            isDragging = true;
            initialX = e.clientX - currentX;
            initialY = e.clientY - currentY;
        });

        document.addEventListener('mousemove', e => {
            if (!isDragging) return;
            e.preventDefault();
            currentX = e.clientX - initialX;
            currentY = e.clientY - initialY;
            menu.style.left = currentX + 'px';
            menu.style.top = currentY + 'px';
            menu.style.bottom = 'auto';
            menu.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => { isDragging = false; });


        document.getElementById('minimizeBtn').onclick = () => {
            config.uiMinimized = !config.uiMinimized;
            menu.classList.toggle('minimized', config.uiMinimized);
            document.getElementById('minimizeBtn').innerHTML = config.uiMinimized ? '⬜' : '➖';
        };


        document.getElementById('toggleBtn').onclick = toggleEnabled;
        document.getElementById('calcBtn').onclick = () => mainLoop(true);
        document.getElementById('clearArrowsBtn').onclick = clearArrows;
        document.getElementById('statusEnabled').onchange = e => {
            setStatusEnabled(e.target.checked);
        };

        document.getElementById('playerColor').onchange = e => {
            config.playerColor = e.target.value;
            dbg("Player color changed to:", config.playerColor);
        };

        document.getElementById('autoSuggest').onchange = e => {
            config.autoSuggest = e.target.checked;
            dbg("Auto suggest:", config.autoSuggest);
        };

        document.getElementById('autoMove').onchange = e => {
            config.autoMove = e.target.checked;
            dbg("Auto move:", config.autoMove);
        };


        document.getElementById('automaticMode').onchange = e => {
            config.automatic = e.target.checked;
            document.getElementById('automaticSettings').style.display = config.automatic ? 'block' : 'none';
            const forceBtn = document.getElementById('forceAutoMove');
            if (forceBtn) forceBtn.disabled = !config.automatic;

            console.log(`[Automatic] Checkbox changed: ${config.automatic ? 'BẬT' : 'TẮT'}`);
            console.log(`[Automatic] Màu hiện tại: ${config.automaticColor}`);

            if (config.automatic) {
                startAutomaticMode();
            } else {
                stopAutomaticMode();
            }
        };

        const forceBtn = document.getElementById('forceAutoMove');
        if (forceBtn) {
            forceBtn.disabled = !config.automatic;
            forceBtn.onclick = () => forceAutomaticMoveNow();
        }

        document.getElementById('automaticColor').onchange = e => {
            config.automaticColor = e.target.value;
            console.log(`[Automatic] Đổi màu thành: ${config.automaticColor}`);
        };

        document.getElementById('automaticMinTime').onchange = e => {
            config.automaticMinTime = parseFloat(e.target.value);

            if (config.automaticMinTime > config.automaticMaxTime) {
                config.automaticMaxTime = config.automaticMinTime;
                document.getElementById('automaticMaxTime').value = config.automaticMaxTime;
            }
            dbg("Automatic min time:", config.automaticMinTime);
        };

        document.getElementById('automaticMaxTime').onchange = e => {
            config.automaticMaxTime = parseFloat(e.target.value);

            if (config.automaticMaxTime < config.automaticMinTime) {
                config.automaticMinTime = config.automaticMaxTime;
                document.getElementById('automaticMinTime').value = config.automaticMinTime;
            }
            dbg("Automatic max time:", config.automaticMaxTime);
        };

        document.getElementById('debugMode').onchange = e => {
            config.debugMode = e.target.checked;
            dbg("Debug mode:", config.debugMode);
        };

        document.getElementById('engineModel').onchange = e => {
            config.engineModel = e.target.value;
            updateStatus("⏳ Đang reload engine...", "#ffaa00");

            const localSettings = document.getElementById('localEngineSettings');
            if (localSettings) {
                localSettings.style.display = isLocalEngine() ? 'block' : 'none';
            }


            if (evaler) {
                evaler.postMessage('quit');
                evaler = null;
            }

            engineReady = false;
            analysisRequestId += 1;
            isCalculating = false;
            bestMoves = [];


            setTimeout(() => initEngine(), 500);
            if (isLocalEngine()) {
                initLocalEngine(true);
            }
        };

        const localServerInput = document.getElementById('localServerUrl');
        if (localServerInput) {
            localServerInput.onchange = e => {
                config.localServerUrl = normalizeServerUrl(e.target.value);
                localServerInput.value = config.localServerUrl;
                if (isLocalEngine()) {
                    updateLocalEngineStatus("Status: checking...", "#ffaa00");
                    initEngine();
                }
            };
        }

        document.getElementById('thinkTime').onchange = e => {
            config.thinkTime = parseFloat(e.target.value);
        };

        document.getElementById('hash').onchange = e => {
            config.hash = parseInt(e.target.value);
            if (evaler && engineReady) {
                evaler.postMessage(`setoption name Hash value ${config.hash}`);
            }
        };

        document.getElementById('numArrows').oninput = e => {
            config.numArrows = parseInt(e.target.value);
            document.getElementById('numArrowsVal').textContent = config.numArrows;
            if (evaler && engineReady) {
                evaler.postMessage(`setoption name MultiPV value ${config.numArrows}`);
            }
        };

        document.getElementById('bestColor').oninput = e => {
            config.bestColor = e.target.value;
        };

        document.getElementById('secondaryColor').oninput = e => {
            config.secondaryColor = e.target.value;
        };

        document.getElementById('opacity').oninput = e => {
            config.opacity = parseFloat(e.target.value);
            document.getElementById('opacityVal').textContent = config.opacity.toFixed(2);
        };

        statusText = document.getElementById('status');
        setStatusEnabled(config.statusEnabled);

        const authorLink = document.getElementById('hieu-author-link');
        if (authorLink) {
            authorLink.onclick = (e) => {
                e.preventDefault();
                window.open('https://www.google.com/search?q=Nguye%E1%BB%85n+M%E1%BA%A1nh+Hi%E1%BA%BFu+info', '_blank', 'noopener');
            };
        }

        const devLink = document.getElementById('hieu-dev-link');
        if (devLink) {
            devLink.onclick = (e) => {
                e.preventDefault();
                window.open('https://www.google.com/search?q=Nguye%E1%BB%85n+M%E1%BA%A1nh+Hi%E1%BA%BFu+info', '_blank', 'noopener');
            };
        }

        const bioBtn = document.getElementById('hieu-bio-btn');
        if (bioBtn) {
            bioBtn.onclick = () => window.open('https://nguyenmanhhieu.info.vn/', '_blank', 'noopener');
        }

        const popupClose = document.getElementById('hieu-popup-close');
        if (popupClose) popupClose.onclick = hideLocalEnginePopup;
        const popupCopy = document.getElementById('hieu-popup-copy');
        if (popupCopy) popupCopy.onclick = copyLocalEngineLink;
        const popupOpen = document.getElementById('hieu-popup-open');
        if (popupOpen) popupOpen.onclick = openLocalEngineLink;
    }

    function updateStatus(text, color = "#88ff88") {
        if (statusText) {
            statusText.textContent = text;
            statusText.style.color = color;
        }
    }

    function queueStatusEval(fen) {
        if (!config.statusEnabled) return false;
        if (!fen || fen.length < 20) return false;
        const key = fen.split(' ').slice(0, 2).join(' ');
        const pendingKey = statusPendingFEN ? statusPendingFEN.split(' ').slice(0, 2).join(' ') : '';
        if (key === statusLastFEN || key === pendingKey) return false;
        statusPendingFEN = fen;
        if (!isCalculating) {
            const started = calculateStatusPosition(statusPendingFEN);
            if (started) {
                statusLastFEN = key;
                statusPendingFEN = '';
            }
            return started;
        }
        return false;
    }

    function flushPendingStatus() {
        if (!config.statusEnabled) return;
        if (!statusPendingFEN) return;
        if (isCalculating) return;
        const fen = statusPendingFEN;
        const key = fen.split(' ').slice(0, 2).join(' ');
        const started = calculateStatusPosition(fen);
        if (started) {
            statusLastFEN = key;
            statusPendingFEN = '';
        }
    }

    function calculateStatusPosition(fen) {
        statusScoreCp = null;
        statusScoreMate = null;
        statusEvalTurn = (fen && fen.split(' ')[1]) || 'w';
        const movetimeMs = Math.max(200, Math.round(config.statusThinkTime * 1000));

        if (isLocalEngine()) {
            return calculateStatusPositionLocal(fen, movetimeMs);
        }

        if (!evaler || !engineReady) return false;
        if (isCalculating) return false;

        statusOnly = true;
        isCalculating = true;

        evaler.postMessage(`setoption name Hash value ${config.hash}`);
        evaler.postMessage(`setoption name MultiPV value 1`);
        evaler.postMessage(`position fen ${fen}`);
        evaler.postMessage(`go movetime ${movetimeMs}`);
        return true;
    }

    function calculateStatusPositionLocal(fen, movetimeMs, options = {}) {
        statusScoreCp = null;
        statusScoreMate = null;
        statusEvalTurn = (fen && fen.split(' ')[1]) || 'w';
        if (!engineReady) {
            initLocalEngine();
            return false;
        }

        analysisRequestId += 1;
        const requestId = analysisRequestId;

        statusOnly = true;
        isCalculating = true;

        const baseUrl = normalizeServerUrl(config.localServerUrl);
        const analyzeUrl = `${baseUrl}/analyze`;
        const payload = {
            fen,
            movetimeMs: Math.max(50, Math.round(movetimeMs)),
            multipv: 1,
            hash: Math.max(16, config.hash)
        };

        httpRequestJson('POST', analyzeUrl, payload, config.localTimeoutMs)
            .then((result) => {
                if (requestId !== analysisRequestId) return;
                if (!result || !result.ok) return;
                const pvs = Array.isArray(result.pvs) ? result.pvs : [];
                const pv = pvs.find(p => (p.multipv || 1) === 1) || pvs[0];
                if (pv) {
                    updateEvalBar(pv.scoreCp, pv.scoreMate);
                }
            })
            .catch((err) => {
                if (requestId !== analysisRequestId) return;
                const message = err && err.message ? err.message : '';
                if (message.includes('HTTP 429') || message.includes('busy')) {
                    const retryCount = options.retry || 0;
                    if (retryCount < 4) {
                        const delay = 150 + retryCount * 150;
                        setTimeout(() => {
                            calculateStatusPositionLocal(fen, movetimeMs, { ...options, retry: retryCount + 1 });
                        }, delay);
                        return;
                    }
                }
                if (err && (err.message === 'Timeout' || err.name === 'AbortError')) {
                    const retryCount = options.retry || 0;
                    if (retryCount < 1) {
                        setTimeout(() => {
                            calculateStatusPositionLocal(fen, movetimeMs, { ...options, retry: retryCount + 1 });
                        }, 200);
                        return;
                    }
                }
            })
            .finally(() => {
                if (requestId === analysisRequestId) {
                    isCalculating = false;
                    statusOnly = false;
                    flushPendingStatus();
                }
            });
        return true;
    }

    function updateEvalBar(scoreCp, scoreMate) {
        if (!config.statusEnabled) return;
        const bar = createStatusBar();
        const fill = document.getElementById('hieu-eval-fill');
        if (!bar || !fill) return;

        let cp = scoreCp;
        let mate = scoreMate;
        if (statusEvalTurn === 'b') {
            if (typeof cp === 'number') cp = -cp;
            if (typeof mate === 'number') mate = -mate;
        }

        let ratio = 50;

        if (typeof mate === 'number') {
            if (mate > 0) {
                ratio = 100;
            } else if (mate < 0) {
                ratio = 0;
            }
        } else if (typeof cp === 'number') {
            const clamp = Math.max(-600, Math.min(600, cp));
            ratio = 50 + (clamp / 600) * 50;
        }

        fill.style.height = ratio + "%";
    }

    function setStatusEnabled(enabled) {
        config.statusEnabled = enabled;
        const bar = createStatusBar();
        if (bar) bar.style.display = enabled ? 'flex' : 'none';
        if (enabled) {
            startStatusLoop();
        } else {
            stopStatusLoop();
        }
    }

    function startStatusLoop() {
        if (statusDebounceTimer) {
            clearTimeout(statusDebounceTimer);
            statusDebounceTimer = null;
        }
        if (statusPollInterval) {
            clearInterval(statusPollInterval);
            statusPollInterval = null;
        }
        const tick = () => {
            if (!config.statusEnabled) return;
            const fen = getCurrentFEN();
            if (!fen || fen.length < 20) return;
            queueStatusEval(fen);
        };
        tick();
        statusPollInterval = setInterval(tick, 350);
    }

    function stopStatusLoop() {
        if (statusDebounceTimer) {
            clearTimeout(statusDebounceTimer);
            statusDebounceTimer = null;
        }
        if (statusPollInterval) {
            clearInterval(statusPollInterval);
            statusPollInterval = null;
        }
        statusPendingFEN = '';
        if (statusOnly) {
            statusOnly = false;
            if (evaler) evaler.postMessage('stop');
            isCalculating = false;
        }
    }

    function toggleEnabled() {
        config.enabled = !config.enabled;
        const btn = document.getElementById('toggleBtn');
        btn.textContent = config.enabled ? '✓ ON' : '⏸ OFF';
        btn.className = `hieu-btn ${config.enabled ? 'active' : ''}`;

        if (!config.enabled) {
            clearArrows();
            if (evaler && !config.statusEnabled) evaler.postMessage('stop');
        }
    }


    function findBoardElement() {
        if (location.host.includes("chess.com")) {
            return document.querySelector('#board-layout-chessboard .board') ||
                   document.querySelector('.board');
        }
        if (location.host.includes("lichess.org")) {
            return document.querySelector('cg-board');
        }
        return null;
    }

    function getCurrentFEN() {

        const gameAPI = getGameAPI();
        if (gameAPI && gameAPI.getFEN) {
            const fen = gameAPI.getFEN();
            dbg("📋 FEN from API:", fen);
            const fenTurn = getTurnFromFENString(fen);
            if (fenTurn) lastTurn = fenTurn;
            const boardKey = fen.split(' ')[0];
            if (boardKey) lastBoardKey = boardKey;
            return fen;
        }


        if (location.host.includes("chess.com")) {
            const boardEl = findBoardElement();
            if (!boardEl) return '';

            let boardState = Array(8).fill().map(() => Array(8).fill('1'));
            const pieces = boardEl.querySelectorAll('[class*="piece"]');

            pieces.forEach(p => {
                const cls = p.className;
                const squareMatch = cls.match(/square-(\d)(\d)/);
                if (!squareMatch) return;

                const file = parseInt(squareMatch[1]) - 1;
                const rank = 8 - parseInt(squareMatch[2]);

                const pieceMatch = cls.match(/([wb])([kqrbnp])/);
                if (!pieceMatch) return;

                const color = pieceMatch[1];
                const type = pieceMatch[2].toUpperCase();
                boardState[rank][file] = color === 'w' ? type : type.toLowerCase();
            });

            const fenRows = boardState.map(row =>
                row.join('').replace(/1+/g, m => m.length)
            ).join('/');


            let turnChar = 'w';
            let turnResolved = false;


            const apiTurn = getTurnFromAPI();
            if (apiTurn) {
                turnChar = apiTurn === 'black' ? 'b' : 'w';
                turnResolved = true;
            } else {

                const highlights = boardEl.querySelectorAll('.highlight');
                if (highlights.length > 0) {
                    let lastMoveColor = null;


                    highlights.forEach(hl => {
                        const cls = hl.className;
                        const squareMatch = cls.match(/square-(\d)(\d)/);
                        if (squareMatch) {
                            const file = parseInt(squareMatch[1]) - 1;
                            const rank = 8 - parseInt(squareMatch[2]);


                            const piece = boardState[rank][file];
                            if (piece !== '1') {
                                lastMoveColor = (piece === piece.toUpperCase()) ? 'w' : 'b';
                            }
                        }
                    });

                    if (lastMoveColor) {
                        turnChar = (lastMoveColor === 'w') ? 'b' : 'w';
                        turnResolved = true;
                    }
                }


                if (!turnResolved && lastTurn) {
                    if (lastBoardKey && lastBoardKey !== fenRows) {
                        turnChar = lastTurn === 'white' ? 'b' : 'w';
                    } else {
                        turnChar = lastTurn === 'white' ? 'w' : 'b';
                    }
                }
            }

            lastBoardKey = fenRows;
            lastTurn = turnChar === 'w' ? 'white' : 'black';

            return fenRows + ` ${turnChar} KQkq - 0 1`;
        }

        if (location.host.includes("lichess.org")) {
            const cg = document.querySelector('cg-board');
            const fen = cg ? (cg.getAttribute('data-fen') || '') : '';
            const fenTurn = getTurnFromFENString(fen);
            if (fenTurn) lastTurn = fenTurn;
            const boardKey = fen.split(' ')[0];
            if (boardKey) lastBoardKey = boardKey;
            return fen;
        }

        return '';
    }

    function getCurrentTurn() {

        const apiTurn = getTurnFromAPI();
        if (apiTurn) {
            lastTurn = apiTurn;
            return apiTurn;
        }


        const fen = getCurrentFEN();
        const fenTurn = getTurnFromFENString(fen);
        if (fenTurn) {
            lastTurn = fenTurn;
            return fenTurn;
        }

        return lastTurn || '';
    }


    function getPlayerColor() {

        if (config.playerColor !== 'auto') {
            return config.playerColor;
        }


        const gameAPI = getGameAPI();
        if (gameAPI && typeof gameAPI.getPlayingAs === 'function') {
            const playingAs = gameAPI.getPlayingAs();
            dbg("🔍 game.getPlayingAs():", playingAs);
            if (playingAs === 1 || playingAs === 'white' || playingAs === 'w') return 'white';
            if (playingAs === 2 || playingAs === 'black' || playingAs === 'b') return 'black';
        }


        const boardEl = findBoardElement();
        if (boardEl) {
            if (boardEl.classList.contains('flipped')) {
                dbg("🔍 Board is flipped -> Player is BLACK");
                return 'black';
            }
        }


        if (location.host.includes('lichess')) {
            const cgWrap = document.querySelector('.cg-wrap');
            if (cgWrap) {
                const orientation = cgWrap.getAttribute('data-orientation');
                if (orientation === 'black') return 'black';
            }
        }


        dbg("🔍 Using default player color: white");
        return 'white';
    }

    function getAutomaticColor() {
        if (config.automaticColor === 'auto') {
            const detected = getPlayerColor();
            return detected || 'white';
        }
        return config.automaticColor;
    }

    function isMyTurn() {
        const currentTurn = getCurrentTurn();
        const playerColor = getPlayerColor();

        dbg(`🎯 Turn check: current=${currentTurn}, player=${playerColor}, isMyTurn=${currentTurn === playerColor}`);

        return currentTurn === playerColor;
    }


    function drawArrow(fromSq, toSq, color, opacity, zIndex = 1000) {
        if (!board) {
            console.error("❌ No board element!");
            return;
        }

        dbg(`🎯 Drawing: ${fromSq} -> ${toSq}, color: ${color}`);

        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");

        svg.style.position = "absolute";
        svg.style.top = "0";
        svg.style.left = "0";
        svg.style.width = "100%";
        svg.style.height = "100%";
        svg.style.pointerEvents = "none";
        svg.style.zIndex = String(zIndex);
        svg.setAttribute('class', 'hieu-arrow-overlay');


        const isFlipped = board.classList.contains('flipped');

        let fileFrom = fromSq.charCodeAt(0) - 97;
        let rankFrom = 8 - parseInt(fromSq[1]);
        let fileTo = toSq.charCodeAt(0) - 97;
        let rankTo = 8 - parseInt(toSq[1]);


        if (isFlipped) {
            fileFrom = 7 - fileFrom;
            rankFrom = 7 - rankFrom;
            fileTo = 7 - fileTo;
            rankTo = 7 - rankTo;
        }

        const x1 = ((fileFrom + 0.5) / 8 * 100) + "%";
        const y1 = ((rankFrom + 0.5) / 8 * 100) + "%";
        const x2 = ((fileTo + 0.5) / 8 * 100) + "%";
        const y2 = ((rankTo + 0.5) / 8 * 100) + "%";

        const markerId = `arrow-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const defs = document.createElementNS(svgNS, "defs");
        const marker = document.createElementNS(svgNS, "marker");
        marker.setAttribute("id", markerId);
        marker.setAttribute("viewBox", "0 0 10 10");
        marker.setAttribute("refX", "8");
        marker.setAttribute("refY", "5");
        marker.setAttribute("markerWidth", "2.5");
        marker.setAttribute("markerHeight", "2.5");
        marker.setAttribute("orient", "auto-start-reverse");

        const poly = document.createElementNS(svgNS, "polygon");
        poly.setAttribute("points", "0,0 10,5 0,10");
        poly.setAttribute("fill", color);
        marker.appendChild(poly);
        defs.appendChild(marker);

        const line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", x1);
        line.setAttribute("y1", y1);
        line.setAttribute("x2", x2);
        line.setAttribute("y2", y2);
        line.setAttribute("stroke", color);
        line.setAttribute("stroke-width", "8");
        line.setAttribute("stroke-opacity", String(opacity));
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("marker-end", `url(#${markerId})`);

        svg.appendChild(defs);
        svg.appendChild(line);
        board.appendChild(svg);
        arrows.push(svg);

        dbg(`✅ Arrow added, total: ${arrows.length}`);
    }

    function clearArrows() {
        arrows.forEach(el => el?.remove());
        arrows = [];
        dbg("🗑️ Arrows cleared");
    }


    function updateAutomaticStatus(text, color = "#00ff9d") {
        const statusEl = document.getElementById('automaticStatus');
        if (statusEl) {
            statusEl.textContent = text;
            statusEl.style.color = color;
        }
    }

    function getRandomThinkTime() {
        const min = config.automaticMinTime;
        const max = config.automaticMaxTime;
        return min + Math.random() * (max - min);
    }

    function forceAutomaticMoveNow() {
        if (!config.automatic) {
            updateAutomaticStatus("⚠️ Bật Automatic trước", "#ffaa00");
            return;
        }
        if (automaticWaitingForMove) {
            updateAutomaticStatus("⏳ Đang xử lý...", "#ffaa00");
            return;
        }

        board = findBoardElement();
        if (!board) {
            updateAutomaticStatus("⚠️ Chưa thấy bàn cờ", "#ffaa00");
            return;
        }

        const fen = getCurrentFEN();
        if (!fen || fen.length < 20) {
            updateAutomaticStatus("⚠️ Không lấy được FEN", "#ff5555");
            return;
        }

        if (!engineReady || (!isLocalEngine() && !evaler)) {
            updateAutomaticStatus("⚠️ Engine chưa sẵn sàng", "#ff5555");
            if (isLocalEngine()) {
                initLocalEngine();
            }
            return;
        }

        automaticWaitingForMove = true;
        automaticLastFEN = fen.split(' ').slice(0, 2).join(' ');
        automaticLastActionAt = Date.now();

        updateAutomaticStatus("⚡ Ép đi ngay...", "#00ff9d");

        bestMoves = [];
        isCalculating = true;

        const baseThink = Math.min(config.automaticMinTime, config.automaticMaxTime);
        const forcedThink = Math.max(0.5, baseThink);
        const moveTimeMs = Math.round(forcedThink * 500);

        if (isLocalEngine()) {
            calculatePositionLocal(fen, 1, moveTimeMs);
        } else if (evaler && engineReady) {
            evaler.postMessage(`setoption name Hash value ${config.hash}`);
            evaler.postMessage(`setoption name MultiPV value 1`);
            evaler.postMessage(`position fen ${fen}`);
            evaler.postMessage(`go movetime ${moveTimeMs}`);
        }

        waitForBestMoveAndPlay();
    }

    function isAutomaticMyTurn() {
        const currentTurn = getCurrentTurn();
        const myColor = getAutomaticColor();
        const isMyTurn = currentTurn === myColor;

        dbg(`🔍 Automatic Turn Check: currentTurn="${currentTurn}", myColor="${myColor}", isMyTurn=${isMyTurn}`);

        return isMyTurn;
    }

    let automaticLastFEN = '';
    let automaticWaitingForMove = false;
    let automaticLastActionAt = 0;
    const AUTOMATIC_RETRY_MS = 2500;

    function automaticMoveLoop() {
        if (!config.automatic) {
            updateAutomaticStatus("⏸ Đã tắt", "#888");
            return;
        }

        board = findBoardElement();
        if (!board) {
            updateAutomaticStatus("⚠️ Chưa thấy bàn cờ", "#ffaa00");
            return;
        }

        const fen = getCurrentFEN();
        if (!fen || fen.length < 20) {
            updateAutomaticStatus("⚠️ Không lấy được FEN", "#ff5555");
            return;
        }

        const apiTurn = getTurnFromAPI();
        const turnFromFEN = getTurnFromFENString(fen);
        const resolvedTurn = apiTurn || turnFromFEN || lastTurn;
        if (resolvedTurn) lastTurn = resolvedTurn;

        if (!resolvedTurn) {
            updateAutomaticStatus("⚠️ Không xác định được lượt", "#ffaa00");
            return;
        }

        const myColor = getAutomaticColor();
        const isMyTurn = resolvedTurn === myColor;
        const fenKey = fen.split(' ').slice(0, 2).join(' ');


        console.log(`[Automatic] Turn: "${resolvedTurn}" | Màu của tôi: ${myColor} | Lượt của tôi: ${isMyTurn}`);


        if (isMyTurn) {

            if (automaticWaitingForMove) {
                updateAutomaticStatus(`🎯 [${myColor === 'white' ? '⬜' : '⬛'}] Đang xử lý...`, "#ffff00");
                return;
            }

            const now = Date.now();
            const shouldTrigger = (fenKey !== automaticLastFEN) || (now - automaticLastActionAt > AUTOMATIC_RETRY_MS);


            if (shouldTrigger) {
                automaticLastFEN = fenKey;
                automaticWaitingForMove = true;
                automaticLastActionAt = now;

                const thinkTime = getRandomThinkTime();
                updateAutomaticStatus(`🤔 [${myColor === 'white' ? '⬜' : '⬛'}] Đang nghĩ... (${thinkTime.toFixed(1)}s)`, "#ffff00");
                console.log(`[Automatic] ĐẾN LƯỢT TÔI! Suy nghĩ ${thinkTime.toFixed(1)}s...`);

                const runAuto = () => {
                    if (!config.automatic) return;


                    const currentFEN = getCurrentFEN();
                    const currentTurnNow = getTurnFromAPI() || getTurnFromFENString(currentFEN) || lastTurn;

                    if (currentTurnNow !== myColor) {
                        updateAutomaticStatus(`⏳ [${myColor === 'white' ? '⬜' : '⬛'}] Chờ lượt...`, "#88ff88");
                        automaticWaitingForMove = false;
                        automaticLastFEN = '';
                        return;
                    }

                    updateAutomaticStatus(`⚡ [${myColor === 'white' ? '⬜' : '⬛'}] Đang tính nước đi...`, "#00ff9d");

                    if (!engineReady || (!isLocalEngine() && !evaler)) {
                        updateAutomaticStatus("⚠️ Engine chưa sẵn sàng", "#ff5555");
                        automaticWaitingForMove = false;
                        automaticLastFEN = '';
                        if (isLocalEngine()) {
                            initLocalEngine();
                        }
                        return;
                    }


                    bestMoves = [];
                    isCalculating = true;

                    const autoMoveTime = Math.round(Math.max(0.5, thinkTime) * 500);

                    if (isLocalEngine()) {
                        calculatePositionLocal(currentFEN, 1, autoMoveTime);
                    } else if (evaler && engineReady) {
                        evaler.postMessage(`setoption name Hash value ${config.hash}`);
                        evaler.postMessage(`setoption name MultiPV value 1`);
                        evaler.postMessage(`position fen ${currentFEN}`);
                        evaler.postMessage(`go movetime ${autoMoveTime}`);
                        console.log(`[Automatic] Gửi FEN cho engine: ${currentFEN}`);
                    }


                    waitForBestMoveAndPlay();

                };

                setTimeout(runAuto, thinkTime * 1000);
            }
        } else {
            automaticWaitingForMove = false;
            automaticLastFEN = '';
            automaticLastActionAt = 0;
            const waitLabel = resolvedTurn === 'white' ? '⬜ Trắng' : resolvedTurn === 'black' ? '⬛ Đen' : 'đối thủ';
            updateAutomaticStatus(`⏳ [${myColor === 'white' ? '⬜' : '⬛'}] Chờ ${waitLabel} đi...`, "#88ff88");
        }
    }

    function waitForBestMoveAndPlay() {
        if (!config.automatic) return;


        let waitCount = 0;
        const maxWait = 100;

        const checkInterval = setInterval(() => {
            waitCount++;

            if (!config.automatic) {
                clearInterval(checkInterval);
                return;
            }


            if (bestMoves.length > 0 && bestMoves[0].moves && bestMoves[0].moves.length > 0) {
                clearInterval(checkInterval);

                const move = bestMoves[0].moves[0];
                const from = move.slice(0, 2);
                const to = move.slice(2, 4);
                const promotion = getPromotionChar(move, from, to);

                updateAutomaticStatus(`🎯 Đánh: ${from}-${to}`, "#00ff9d");
                dbg(`🤖 Automatic move: ${from} -> ${to}`);

                setTimeout(() => {
                    makeAutoMove(from, to, promotion);
                    automaticWaitingForMove = false;


                    setTimeout(() => {
                        const currentFen = getCurrentFEN();
                        automaticLastFEN = currentFen ? currentFen.split(' ').slice(0, 2).join(' ') : '';
                        automaticLastActionAt = Date.now();
                        updateAutomaticStatus("✅ Đã đánh xong!", "#00ff9d");
                    }, 500);
                }, 200);
            } else if (waitCount >= maxWait) {
                clearInterval(checkInterval);
                updateAutomaticStatus("⚠️ Timeout - thử lại...", "#ff5555");
                automaticWaitingForMove = false;
                automaticLastFEN = '';
                automaticLastActionAt = 0;
            }
        }, 100);
    }

    function startAutomaticMode() {
        dbg("🚀 Starting Automatic Mode...");


        const resolvedColor = getAutomaticColor();
        if (config.automaticColor === 'auto') {
            console.log(`[Automatic] Auto-detected color: ${resolvedColor}`);
        }

        updateAutomaticStatus(`?? Auto: ${resolvedColor === 'white' ? 'Tr?ng' : '?en'}`, "#00ff9d");


        if (automaticInterval) {
            clearInterval(automaticInterval);
        }


        const startFen = getCurrentFEN();
        automaticLastFEN = startFen ? startFen.split(' ').slice(0, 2).join(' ') : '';
        automaticLastActionAt = 0;


        automaticInterval = setInterval(automaticMoveLoop, 500);


        automaticMoveLoop();
    }

    function stopAutomaticMode() {
        dbg("⏹️ Stopping Automatic Mode...");
        updateAutomaticStatus("⏸ Đã dừng", "#888");

        if (automaticInterval) {
            clearInterval(automaticInterval);
            automaticInterval = null;
        }

        automaticWaitingForMove = false;
        automaticLastFEN = '';
        automaticLastActionAt = 0;
    }


    function mainLoop(force = false) {
        if (!config.enabled && !force) return;

        board = findBoardElement();
        if (!board) {
            updateStatus("Chưa thấy bàn cờ", "#ffaa00");
            return;
        }

        let fen = getCurrentFEN();
        if (!fen || fen.length < 20) {
            updateStatus("Không lấy được FEN", "#ff5555");
            return;
        }


        if (force) {
            const fenParts = fen.split(' ');
            const currentTurnInFEN = fenParts[1];


            const playerColor = getPlayerColor();
            const playerTurnChar = playerColor === 'white' ? 'w' : 'b';

            console.log(`[Tính] Player color detected: ${playerColor}, FEN turn: ${currentTurnInFEN}`);


            if (currentTurnInFEN !== playerTurnChar) {
                fenParts[1] = playerTurnChar;
                fen = fenParts.join(' ');
                console.log(`[Tính] Đổi FEN turn từ "${currentTurnInFEN}" thành "${playerTurnChar}" để tính cho ${playerColor}`);
                updateStatus(`⚡ Tính cho ${playerColor === 'white' ? '⬜ Trắng' : '⬛ Đen'}...`, "#ffff00");
            } else {
                updateStatus(`⚡ Đang tính cho ${playerColor === 'white' ? '⬜ Trắng' : '⬛ Đen'}...`, "#88ff88");
            }
        }


        if (config.autoSuggest && !force) {
            if (!isMyTurn()) {
                dbg("Not my turn, skipping...");
                return;
            }
        }


        if (fen === lastFEN && !force) {
            dbg("Same position, skipping...");
            return;
        }

        const started = calculatePosition(fen);
        if (started) lastFEN = fen;
    }


    function init() {
    console.log("🚀 Starting Hiếu Chess.com Assist V2.5...");

        createMenu();
        initEngine();

        setTimeout(() => {
            board = findBoardElement();
            if (board) {
                updateStatus("✅ Board found!", "#00ff9d");


                const observer = new MutationObserver(() => {
                    if (config.enabled && config.autoSuggest && !isCalculating) {
                        setTimeout(() => mainLoop(), 300);
                    }
                    if (config.statusEnabled) {
                        if (statusDebounceTimer) clearTimeout(statusDebounceTimer);
                        statusDebounceTimer = setTimeout(() => {
                            const fen = getCurrentFEN();
                            queueStatusEval(fen);
                        }, 200);
                    }
                });

                observer.observe(board, {
                    childList: true,
                    subtree: true
                });

                dbg("✅ Observer started");
            } else {
                updateStatus("Board not found", "#ffaa00");
            }
        }, 2000);
    }

    init();

    console.log("%c🎯 Hiếu Chess.com Assist V2.5 loaded!", "color:#0f0; font-weight:bold; font-size:16px;");



    const targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    targetWindow.HieuChess = {
        config,
        calculateNow: () => mainLoop(true),
        clearArrows,
        testMove: (from, to, promotion) => makeAutoMove(from, to, promotion),
        getFEN: getCurrentFEN,
        getTurn: getCurrentTurn,
        getPlayerColor,
        isMyTurn,
        toggleDebug: () => {
            config.debugMode = !config.debugMode;
            console.log("Debug mode:", config.debugMode);
            document.getElementById('debugMode').checked = config.debugMode;
        },
        toggleMinimize: () => {
            document.getElementById('minimizeBtn').click();
        }
    };

    console.log("💡 Debug API: window.HieuChess (or HieuChess)");
    console.log("   - HieuChess.calculateNow()");
    console.log("   - HieuChess.testMove('e2', 'e4')");
    console.log("   - HieuChess.getPlayerColor()");
    console.log("   - HieuChess.isMyTurn()");
    console.log("   - HieuChess.toggleDebug()");

})();
