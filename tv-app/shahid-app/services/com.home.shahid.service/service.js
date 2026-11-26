/*
 * com.home.shahid.service
 *
 * Background service for the "Shahid" webOS app.
 * - HTTP server (57100): receives the allowed max volume from the mobile app.
 * - UDP responder (57099): optional LAN discovery.
 * - Persists the cap to disk and clamps the TV volume down whenever it goes above it.
 *
 * Must stay ES5 / Node 0.12 compatible (webOS TV 3.x-4.x): no let/const,
 * no arrow functions, no Buffer.from, no fs options objects.
 */

var pkgInfo = require('./package.json');
var Service = require('webos-service');
var fs = require('fs');
var path = require('path');

var service = new Service(pkgInfo.name);
var logHeader = '[' + pkgInfo.name + ']';

var DISCOVERY_PORT = 57099;
var HTTP_PORT = 57100;
var MAGIC = 'LGVOL_DISCOVER_V1';

var AUDIO_BUS_CANDIDATES = ['luna://com.webos.audio', 'luna://com.webos.service.audio'];
var ACTIVITY_BUS = 'luna://com.palm.activitymanager';
var audioBus = null;

// Saved to every location that accepts the write; the newest copy wins on load.
// The app's own folder is wiped on reinstall, so locations outside it come first.
var STORAGE_DIRS = ['/media/developer/temp', '/media/developer', '/var/tmp', path.join(__dirname, 'data'), '/tmp'];
var DB_BUS = 'luna://com.palm.db';
var DB_KIND = 'com.home.shahid:1';
var STORAGE_NAME = 'shahid-volume-cap.json';

var diag = {
    startedAt: Date.now(),
    keepAlive: false,
    httpOk: false,
    httpError: null,
    udpOk: false,
    udpError: null,
    storageFile: null,
    storageError: null,
    volume: null,
    lastAudio: null,
    lastClamp: null,
    bootActivity: null,
    lastError: null
};

function log() {
    var args = Array.prototype.slice.call(arguments);
    console.log.apply(console, [logHeader].concat(args));
}

function short(obj) {
    try {
        return JSON.stringify(obj).slice(0, 300);
    } catch (e) {
        return String(obj);
    }
}

function payloadOf(message) {
    return (message && message.payload) || {};
}

// A service that must run forever cannot let one bad packet or request kill it.
process.on('uncaughtException', function(err) {
    diag.lastError = String((err && err.stack) || err).slice(0, 500);
    log('uncaughtException:', diag.lastError);
});

// webOS terminates idle JS services after a few seconds. An open activity
// keeps this one alive so the HTTP/UDP listeners stay up.
try {
    service.activityManager.create('shahid-keepalive', function() {
        diag.keepAlive = true;
        log('keepAlive activity created');
    });
} catch (e) {
    diag.lastError = 'keepAlive: ' + (e && e.message);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function readCapFrom(dir) {
    try {
        var parsed = JSON.parse(fs.readFileSync(path.join(dir, STORAGE_NAME), 'utf8'));
        if (parsed && typeof parsed.cap === 'number' && parsed.cap >= 0 && parsed.cap <= 100) {
            return parsed;
        }
    } catch (e) {
        // missing or unreadable
    }
    return null;
}

function loadCapRecord() {
    var best = null;
    for (var i = 0; i < STORAGE_DIRS.length; i++) {
        var rec = readCapFrom(STORAGE_DIRS[i]);
        if (rec && (!best || (rec.updatedAt || 0) > (best.updatedAt || 0))) {
            best = rec;
        }
    }
    return best;
}

function loadCap() {
    var rec = loadCapRecord();
    capUpdatedAt = rec ? (rec.updatedAt || 0) : 0;
    return rec ? rec.cap : null;
}

function saveCapToFiles(record) {
    var data = JSON.stringify(record);
    var saved = [];
    var errors = [];
    for (var i = 0; i < STORAGE_DIRS.length; i++) {
        var dir = STORAGE_DIRS[i];
        try {
            try {
                fs.mkdirSync(dir);
            } catch (e) {
                if (e.code !== 'EEXIST') throw e;
            }
            fs.writeFileSync(path.join(dir, STORAGE_NAME), data, 'utf8');
            saved.push(dir);
        } catch (e) {
            errors.push(dir + ': ' + (e && e.message));
        }
    }
    diag.storageFile = saved.join(', ') || null;
    diag.storageError = errors.length ? errors.join(' | ') : null;
    return saved.length > 0;
}

// DB8 is webOS's own persistent store; it survives reboots independently of
// which folders this service may write to.
var dbReady = false;
function ensureDbKind(cb) {
    if (dbReady) return cb(true);
    service.call(DB_BUS + '/putKind', {
        id: DB_KIND,
        owner: pkgInfo.name,
        indexes: [{ name: 'updatedAt', props: [{ name: 'updatedAt' }] }]
    }, function(message) {
        var p = payloadOf(message);
        dbReady = !!p.returnValue;
        diag.db = 'putKind -> ' + short(p);
        cb(dbReady);
    });
}

function saveCapToDb(record) {
    ensureDbKind(function(ok) {
        if (!ok) return;
        service.call(DB_BUS + '/del', { query: { from: DB_KIND } }, function() {
            service.call(DB_BUS + '/put', { objects: [{ _kind: DB_KIND, cap: record.cap, updatedAt: record.updatedAt }] }, function(message) {
                diag.db = 'put -> ' + short(payloadOf(message));
            });
        });
    });
}

function loadCapFromDb() {
    ensureDbKind(function(ok) {
        if (!ok) return;
        service.call(DB_BUS + '/find', {
            query: { from: DB_KIND, orderBy: 'updatedAt', desc: true, limit: 1 }
        }, function(message) {
            var p = payloadOf(message);
            var rec = p.results && p.results[0];
            diag.db = 'find -> ' + short(p);
            if (rec && typeof rec.cap === 'number' && (rec.updatedAt || 0) > capUpdatedAt) {
                currentCap = rec.cap;
                capUpdatedAt = rec.updatedAt || 0;
                saveCapToFiles({ cap: currentCap, updatedAt: capUpdatedAt });
                checkVolumeNow();
            }
        });
    });
}

function saveCap(value) {
    var record = { cap: value, updatedAt: Date.now() };
    capUpdatedAt = record.updatedAt;
    var savedToFile = saveCapToFiles(record);
    saveCapToDb(record);
    return savedToFile;
}

var capUpdatedAt = 0;
var currentCap = loadCap();
log('startup, currentCap =', currentCap);

// ---------------------------------------------------------------------------
// Luna methods
// ---------------------------------------------------------------------------

function noteStartedBy(who) {
    if (!diag.startedBy) diag.startedBy = who;
}

service.register('status', function(message) {
    noteStartedBy('status (app opened)');
    message.respond({
        returnValue: true,
        cap: currentCap,
        audioBus: audioBus,
        httpPort: HTTP_PORT,
        diag: diag
    });
});

service.register('bootKick', function(message) {
    noteStartedBy('bootKick (5m schedule)');
    diag.lastBootKick = Date.now();
    message.respond({ returnValue: true });
    startVolumeWatch();
    // Responding completes the activity that called us, so arm the next one.
    setTimeout(armBootActivity, 3000);
});

// ---------------------------------------------------------------------------
// Volume enforcement
// ---------------------------------------------------------------------------

function extractVolume(p) {
    if (!p) return null;
    if (typeof p.volume === 'number') return p.volume;
    if (p.volumeStatus && typeof p.volumeStatus.volume === 'number') return p.volumeStatus.volume;
    return null;
}

function callAudio(method, params, cb) {
    var candidates = audioBus ? [audioBus] : AUDIO_BUS_CANDIDATES;
    var i = 0;
    function tryNext() {
        if (i >= candidates.length) {
            if (cb) cb({ returnValue: false, errorText: 'no audio bus accepted ' + method });
            return;
        }
        var bus = candidates[i++];
        service.call(bus + method, params, function(message) {
            var p = payloadOf(message);
            diag.lastAudio = bus + method + ' -> ' + short(p);
            if (p.returnValue) {
                audioBus = bus;
                if (cb) cb(p);
            } else {
                tryNext();
            }
        });
    }
    tryNext();
}

function stepDown(times) {
    if (times <= 0) return;
    callAudio('/volumeDown', {}, function(p) {
        diag.lastClamp = 'volumeDown -> ' + short(p);
        if (p.returnValue) stepDown(times - 1);
    });
}

var clamping = false;
function clampVolumeIfNeeded(vol) {
    if (currentCap === null || vol === null || vol <= currentCap || clamping) return;
    clamping = true;
    var target = currentCap;
    callAudio('/setVolume', { volume: target }, function(p) {
        clamping = false;
        diag.lastClamp = 'setVolume ' + vol + '->' + target + ': ' + short(p);
        if (!p.returnValue) {
            stepDown(vol - target);
        }
    });
}

function checkVolumeNow() {
    callAudio('/getVolume', {}, function(p) {
        var vol = extractVolume(p);
        if (vol !== null) {
            diag.volume = vol;
            clampVolumeIfNeeded(vol);
        }
    });
}

var volumeSub = null;
function startVolumeWatch() {
    if (volumeSub) return;
    var bus = audioBus || AUDIO_BUS_CANDIDATES[0];
    try {
        volumeSub = service.subscribe(bus + '/getVolume', { subscribe: true });
        volumeSub.on('response', function(message) {
            var p = payloadOf(message);
            diag.lastAudio = 'sub ' + bus + ' -> ' + short(p);
            var vol = extractVolume(p);
            if (vol !== null) {
                diag.volume = vol;
                clampVolumeIfNeeded(vol);
            }
        });
        volumeSub.on('cancel', function() {
            volumeSub = null;
        });
    } catch (e) {
        volumeSub = null;
        diag.lastError = 'subscribe: ' + (e && e.message);
    }
}

startVolumeWatch();
// Backstop in case the subscription is not delivered on this firmware.
setInterval(checkVolumeNow, 1500);

// ---------------------------------------------------------------------------
// HTTP server - receives the new cap from the mobile app
// ---------------------------------------------------------------------------

function sendJson(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

try {
    var http = require('http');
    var httpServer = http.createServer(function(req, res) {
        if (req.url === '/ping') {
            sendJson(res, 200, { ok: true, app: 'shahid', cap: currentCap });
            return;
        }
        if (req.url === '/status') {
            sendJson(res, 200, { ok: true, cap: currentCap, audioBus: audioBus, diag: diag });
            return;
        }
        if (req.method === 'POST' && req.url === '/volume-cap') {
            var body = '';
            req.on('data', function(chunk) {
                body += chunk;
                if (body.length > 1024) req.destroy();
            });
            req.on('end', function() {
                var parsed = null;
                try {
                    parsed = JSON.parse(body);
                } catch (e) {
                    sendJson(res, 400, { ok: false, error: 'invalid json' });
                    return;
                }
                var raw = parsed && typeof parsed === 'object' ? parsed.value : null;
                var value = (raw === null || raw === undefined || raw === '') ? NaN : Number(raw);
                if (!isFinite(value) || value < 0 || value > 100) {
                    sendJson(res, 400, { ok: false, error: 'value must be a number between 0 and 100' });
                    return;
                }
                currentCap = Math.round(value);
                var saved = saveCap(currentCap);
                log('new cap received:', currentCap, 'saved:', saved);
                checkVolumeNow();
                sendJson(res, 200, { ok: true, cap: currentCap, saved: saved });
            });
            return;
        }
        sendJson(res, 404, { ok: false, error: 'not found' });
    });
    httpServer.on('error', function(err) {
        diag.httpError = err && err.message;
    });
    httpServer.listen(HTTP_PORT, function() {
        diag.httpOk = true;
        log('HTTP server listening on', HTTP_PORT);
    });
} catch (e) {
    diag.httpError = e && e.message;
}

// ---------------------------------------------------------------------------
// UDP discovery
// ---------------------------------------------------------------------------

try {
    var dgram = require('dgram');
    var udpSocket = dgram.createSocket('udp4');
    udpSocket.on('error', function(err) {
        diag.udpError = err && err.message;
    });
    udpSocket.on('message', function(msg, rinfo) {
        if (msg.toString('utf8') !== MAGIC) return;
        var reply = new Buffer(JSON.stringify({ magic: MAGIC, app: 'shahid', httpPort: HTTP_PORT }), 'utf8');
        udpSocket.send(reply, 0, reply.length, rinfo.port, rinfo.address);
    });
    udpSocket.on('listening', function() {
        diag.udpOk = true;
        try {
            udpSocket.setBroadcast(true);
        } catch (e) {
            // not needed for replying
        }
    });
    udpSocket.bind(DISCOVERY_PORT);
} catch (e) {
    diag.udpError = e && e.message;
}

// ---------------------------------------------------------------------------
// Boot persistence: a persistent, repeating activity. webOS keeps it across
// reboots and calls bootKick on schedule, which (re)starts this service.
// Each call completes the activity, so bootKick re-arms it.
// ---------------------------------------------------------------------------

function activitySpecs() {
    var base = {
        name: 'shahid-volume-guard',
        description: 'start the volume guard service and keep it running',
        schedule: { interval: '5m' },
        callback: { method: 'luna://' + pkgInfo.name + '/bootKick', params: {} }
    };
    var typed = JSON.parse(JSON.stringify(base));
    typed.type = { background: true, persist: true, explicit: true };
    var flat = JSON.parse(JSON.stringify(base));
    flat.background = true;
    flat.persist = true;
    flat.explicit = true;
    return [typed, flat];
}

// webOS versions disagree on the activity format, so try each until one is accepted.
function armBootActivity() {
    var specs = activitySpecs();
    var results = [];
    var i = 0;
    function tryNext() {
        if (i >= specs.length) {
            diag.bootActivity = 'all rejected: ' + results.join(' | ');
            return;
        }
        var spec = specs[i++];
        try {
            service.call(ACTIVITY_BUS + '/create', {
                activity: spec,
                start: true,
                replace: true,
                subscribe: false
            }, function(message) {
                var p = payloadOf(message);
                results.push(short(p));
                if (p.returnValue) {
                    diag.bootActivity = 'ok (format ' + i + '): ' + short(p);
                } else {
                    tryNext();
                }
            });
        } catch (e) {
            results.push('threw: ' + (e && e.message));
            tryNext();
        }
    }
    tryNext();
}

// Second boot path: an explicit persistent activity that is deliberately never
// answered. Answering would complete it; webOS relaunches incomplete explicit
// persistent activities when it starts, and that relaunch starts this service.
var heldBootMessages = [];
service.register('bootHold', function(message) {
    noteStartedBy('bootHold (boot)');
    diag.lastBootHold = Date.now();
    heldBootMessages.push(message);
    if (heldBootMessages.length > 5) heldBootMessages.shift();
    startVolumeWatch();
});

function armHoldActivity() {
    try {
        service.call(ACTIVITY_BUS + '/create', {
            activity: {
                name: 'shahid-boot-hold',
                description: 'start the volume guard service at boot',
                type: { background: true, persist: true, explicit: true },
                callback: { method: 'luna://' + pkgInfo.name + '/bootHold', params: {} }
            },
            start: true,
            replace: true,
            subscribe: false
        }, function(message) {
            diag.holdActivity = short(payloadOf(message));
        });
    } catch (e) {
        diag.holdActivity = 'threw: ' + (e && e.message);
    }
}

armBootActivity();
loadCapFromDb();
// If webOS already relaunched the hold activity (i.e. this start came from it),
// keep that one; otherwise create it.
setTimeout(function() {
    if (!heldBootMessages.length) armHoldActivity();
}, 10000);
