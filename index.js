'use strict'

const path = require('path');
const fs = require('fs');
const mkdirp = require('mkdirp-no-bin');
const rmdir = require('rmdir');

/*
All implementing strategies must implement the protocol described in this section.

Accept an existing connection to data stores via the optionsObject.
Manage connections created by itself.

The factory function should return an object (client) that has the following methods and properties:
await (boolean property): true indicates that the strategy's methods are all async functions. If false, all methods must have a callback(err, result) as the last parameter.

start([callback]) (optional): clients that require extra initialization, e.g. to start a database connection, may export this method. When present, this method must be invoked by the user before any other method. This method may be an async function at the discretion of the implementor.
stop([callback]) (optional): required when start() is present. This should shutdown any connections/processes started via start(). It is left to the user to invoke this method in their shutdown procedure. This method may be an async function at the discretion of the implementor.
*/

/*
In all cases where a key is required, the key may be a simple string, or it may be an object of the format {id: 'name', segment: 'name'}. It is up to the implementing strategy to decide how to handle these keys.
*/
function mapKey (inputKey, segment) {
    const parts = []
    if (typeof inputKey === 'string') {
        parts.push(encodeURIComponent(segment))
        parts.push(encodeURIComponent(inputKey))
    } 
    else {
        parts.push(encodeURIComponent(inputKey.segment))
        parts.push(encodeURIComponent(inputKey.id))
    }

    return parts.join(':')
}

function exists(dir) {
    try {
        fs.accessSync(dir)
    } 
    catch(err) {
        return false
    }

    return true
}

function safeCb(cb) {
    if (typeof cb === 'function') return cb
    return function(){}
}

const proto = {

    // buildFilePath() and buildCacheEnry() are required by abstract-file-cache
    buildFilePath: function (key) {
        const _key = mapKey(key, this._segment)
        return path.normalize(cacheDir + '/' + _key + '.json')
    },

    buildCacheEntry: function (data) {
        return {
            cacheUntil: !cacheInfinitely ? new Date().getTime() + cacheDuration : undefined,
            data: data
        }
    },

    // The following are required by abstract-cache

    // `await` is set to false because abstract-cache-file uses callbacks
    // instead of async/await
    await: false,

    // delete(key[, callback]): removes the specified item from the cache
    delete: function (key, cb) {
        const _key = mapKey(key, this._segment)
        if(ram) {
            delete memoryCache[_key];

            if(!persist){
                safeCb(cb)(null)
            }
        }

        fs.unlink(buildFilePath(_key), cb);
    },

    // get(key[, callback]): retrieves the desired item from the cache. 
    // The returned item should be a deep copy of the stored value to 
    // prevent alterations from affecting the cache. The result should 
    // be an object with the properties:
    //    item: the item the user cached.
    //    stored: a Date, in Epoch milliseconds, indicating when the item was stored.
    //    ttl: the remaining lifetime of the item in the cache (milliseconds).
    get: function (key, cb) {
        const _key = mapKey(key, this._segment)

        // return this._redis.get(_key)
        //     .then((result) => {
        //         if (!result) return Promise.resolve(result)
        //         const _result = JSON.parse(result)
        //         const now = Date.now()
        //         const expires = _result.ttl + _result.stored
        //         const ttl = expires - now
        //         return Promise.resolve({
        //             item: _result.item,
        //             stored: _result.stored,
        //             ttl
        //         })
        //     })
        if(ram && !!memoryCache[_key]) {
            const entry = memoryCache[_key];

            if(!!entry.cacheUntil && new Date().getTime() > entry.cacheUntil) {
                return safeCb(cb)(null, undefined);
            }

            return safeCb(cb)(null, JSON.parse(entry));
        }

        fs.readFile(buildFilePath(_key), 'utf8', function (err, content) {
            if(err != null) {
                return safeCb(cb)(null, undefined);
            }

            var entry = JSON.parse(content);

            if(!!entry.cacheUntil && new Date().getTime() > entry.cacheUntil) {
                return safeCb(cb)(null, undefined);
            }

            return safeCb(cb)(null, entry);
        })

    },

    // has(key[, callback]): returns a boolean result indicating if the 
    // cache contains the desired key.

    // cribbed has from
    // https://github.com/chungkitchan/persistent-cache/blob/master/index.js#L170
    has: function (key, cb) {
        const _key = mapKey(key, this._segment)
        //return this._redis.exists(_key).then((result) => Boolean(result))

        if (ram && !persist) {
            return memoryCache.hasOwnProperty(_key);
        }

        return fs.existsSync(buildFilePath(_key));
    },

    // set(key, value, ttl[, callback]): stores the specified value in 
    // the cache under the specified key for the time ttl in milliseconds.
    set: function (key, value, ttl, cb) {
        const _key = mapKey(key, this._segment)
        const payload = {
            item: value,
            stored: Date.now(),
            ttl
        }

        if(persist) {
            fs.writeFile(buildFilePath(_key), JSON.stringify(payload), cb)
        }

        if(ram) {
            entry.data = JSON.stringify(entry.data);

            memoryCache[name] = entry;

            if(!persist) {
                return safeCb(cb)(null)
            }
        }

        // Supposedly there is some sort of "PX" option for Redis's `set()` method,
        // but I have no idea how to use it. At least not with ioredis.
        // return this._redis.set(_key, JSON.stringify(payload))
        //     .then(() => {
        //         const ttlSec = Math.max(1, Math.floor(ttl / 1000))
        //         return this._redis.expire(_key, ttlSec)
        //     })
    },

    // the following is optional from the point of abstract-cache
    // but is provided as inherited from persistent-cache
    keys: function (cb) {
        //const _key = mapKey(pattern, this._segment)
        // return this._redis.keys(_key)
        // .then((result) => {
        //     const res = result.map(e => e.split(':')[1])
        //     return Promise.resolve(res)
        // })

        cb = safeCb(cb);

        if(ram && !persist)
            return cb(null, Object.keys(memoryCache));

        fs.readdir(cacheDir, function (err, files) {
            return !!err ? cb(err) : cb(err, files.map(f => { return f.slice(0, -5) })
            )
        })
    }
}

// The module should export a factory function (optionsObject) {}.
module.exports = function abstractCacheFileFactory (config) {
    const _config = config || {}
    if (!_config.client) throw Error('abstract-cache-file: invalid configuration')

    const base = path.normalize(
        (
            _config.base || 
            (require.main ? path.dirname(require.main.filename) : undefined) || 
            process.cwd()
        ) + '/cache'
    )

    const cacheDir = path.normalize(base + '/' + (_config.name || 'cache'))
    const cacheInfinitely = !(typeof _config.duration === "number")
    const cacheDuration = _config.duration
    const ram = typeof _config.memory == 'boolean' ? _config.memory : true
    const persist = typeof _config.persist == 'boolean' ? _config.persist : true
    const client = _config.client
    const segment = _config.segment || 'abstractCacheFile'

    let memoryCache
    if (ram) {
        memoryCache = {}
    }

    if(persist && !exists(cacheDir)) {
        mkdirp.sync(cacheDir)
    }

    const instance = Object.create(proto)
    
    Object.defineProperties(instance, {
        await: {
            enumerable: false,
            value: false
        },
        _segment: {
            enumerable: false,
            value: segment
        }
    })

    return instance
}