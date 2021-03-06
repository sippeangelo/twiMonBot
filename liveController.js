var debug = require('debug')('liveController');
var debugLog = require('debug')('liveController:log');
debugLog.log = console.log.bind(console);
var base = require('./base');
var Promise = require('bluebird');

var LiveController = function (options) {
    "use strict";
    var _this = this;
    this.gOptions = options;
    this.config = {};

    this.config.liveList = this.gOptions.storage.lastStreamList;

    this.saveStreamListThrottle = base.throttle(this.saveStreamList, 250, this);

    options.events.on('updateLiveList', function(service, videoList, channelList) {
        _this.update(service, videoList, channelList);
    });

    options.events.on('saveStreamList', function () {
        _this.saveStreamListThrottle();
    });
};

LiveController.prototype.saveStreamList = function () {
    return base.storage.set({
        lastStreamList: this.config.liveList
    });
};

LiveController.prototype.prepLiveListCache = function (service, liveList) {
    var streamIdList = {};
    var channelsStreamList = {};
    liveList.forEach(function (item) {
        if (item._service !== service) {
            return;
        }
        streamIdList[item._id] = item;
        var channelStreamList = channelsStreamList[item._channelId];
        if (!channelStreamList) {
            channelStreamList = channelsStreamList[item._channelId] = [];
        }
        channelStreamList.push(item);
    });
    return {
        streamIdList: streamIdList,
        channelsStreamList: channelsStreamList
    };
};

LiveController.prototype.updateObj = function (oldObj, newObj) {
    var _this = this;
    var diff = [];
    var keys = Object.keys(newObj);
    keys.forEach(function (key) {
        var oldValue = oldObj[key];
        var value = newObj[key];

        if (typeof value === 'object' && value && oldValue) {
            if (Array.isArray(value)) {
                if (JSON.stringify(value) !== JSON.stringify(oldValue)) {
                    diff.push(key);
                    oldObj[key] = value;
                }
            } else {
                diff.push.apply(diff, _this.updateObj(oldValue, value));
            }
        } else
        if (oldValue !== value) {
            diff.push(key);
            oldObj[key] = value;
        }
    });
    return diff;
};

LiveController.prototype.findDblStream = function (oldStreamList, newItem) {
    var id = null;
    oldStreamList.some(function (item) {
       if (
           item.channel.status === newItem.channel.status &&
           item.channel.game === newItem.channel.game) {
           id = item._id;
           return true;
       }
    });
    return id;
};

LiveController.prototype.update = function (service, newLiveList, channelList) {
    var _this = this;

    var timeout = this.gOptions.config.timeout;

    var liveList = this.config.liveList;
    var now = base.getNow();

    var cache = this.prepLiveListCache(service, liveList);
    var lastStreamIdObj = cache.streamIdList;
    var lastChannelStreamObj = cache.channelsStreamList;

    var removeItemFromLiveList = function (item) {
        var pos = liveList.indexOf(item);
        if (pos !== -1) {
            liveList.splice(pos, 1);
        }
    };

    var logStream = function (_stream) {
        var stream = JSON.parse(JSON.stringify(_stream));
        delete stream.preview;
        return stream;
    };

    newLiveList.forEach(function (item) {
        var channelStreamList = null;
        if (item._isTimeout) {
            channelStreamList = lastChannelStreamObj[item._channelId];
            channelStreamList && channelStreamList.forEach(function (oldItem) {
                // stream exists, update info
                delete lastStreamIdObj[oldItem._id];
                // set timeout status
                if (!oldItem._isTimeout) {
                    oldItem._isTimeout = true;

                    debugLog('Timeout (U) %s %j', oldItem._channelId, logStream(oldItem));
                    _this.gOptions.events.emit('updateNotify', oldItem);
                }
            });
            return;
        }

        var changes = null;
        var id = item._id;
        var oldItem = lastStreamIdObj[id];
        if (oldItem) {
            // stream exists, update info
            delete lastStreamIdObj[id];
            // don't inherit insert time
            delete item._insertTime;
            // rm photo cache
            delete oldItem._photoId;
            
            changes = _this.updateObj(oldItem, item);

            if (changes.indexOf('_isOffline') !== -1 || changes.indexOf('_isTimeout') !== -1) {
                debugLog('Online (U) %s %j', oldItem._channelId, logStream(oldItem));
                _this.gOptions.events.emit('updateNotify', oldItem);
            } else
            if (changes.indexOf('game') !== -1 || changes.indexOf('status') !== -1) {
                // notify when status of game change
                debugLog('Changes (U) %s %j', oldItem._channelId, logStream(oldItem));
                _this.gOptions.events.emit('updateNotify', oldItem);
            }
            return;
        }

        var channelId = item._channelId;
        channelStreamList = lastChannelStreamObj[channelId];
        if (!channelStreamList) {
            // is new stream, notify
            liveList.push(item);
            debugLog('New (N) %s %j', item._channelId, logStream(item));
            item._notifyTime = now;
            _this.gOptions.events.emit('notify', item);
            return;
        }

        var dbId = _this.findDblStream(channelStreamList, item);
        oldItem = lastStreamIdObj[dbId];
        if (oldItem) {
            // stream is crash, found prev item update it
            delete lastStreamIdObj[dbId];
            // don't inherit insert time
            delete item._insertTime;
            // rm photo cache
            delete oldItem._photoId;

            changes = _this.updateObj(oldItem, item);

            if (changes.indexOf('_isOffline') !== -1 || changes.indexOf('_isTimeout') !== -1) {
                debugLog('Online dbl (U) %s %j', oldItem._channelId, logStream(oldItem));
                _this.gOptions.events.emit('updateNotify', oldItem);
            } else {
                debugLog('Dbl %s %j', oldItem._channelId, logStream(oldItem));
            }
            return;
        }

        // more one stream from channelId
        liveList.push(item);
        debugLog('Dbl (N) %s %j', item._channelId, logStream(item));
        item._notifyTime = now;
        return _this.gOptions.events.emit('notify', item);
    });

    Object.keys(lastStreamIdObj).forEach(function (key) {
        // check offline channels
        var item = lastStreamIdObj[key];
        var channelId = item._channelId;

        if (channelList.indexOf(channelId) === -1) {
            if (now - item._checkTime > 3600) {
                // if item don't check more 1h
                debugLog('Remove unused %s %j', item._channelId, logStream(item));
                removeItemFromLiveList(item);
            }
            return;
        }

        if (!item._isOffline) {
            // set offline status
            item._isOffline = true;
            item._offlineStartTime = now;
            debugLog('Offline (U) %s %j', item._channelId, logStream(item));
            _this.gOptions.events.emit('updateNotify', item);
        } else
        if (now - item._offlineStartTime > timeout) {
            // if offline status > timeout - remove item
            debugLog('Remove %s %j', item._channelId, logStream(item));
            removeItemFromLiveList(item);
        }
    });

    return this.saveStreamList();
};

module.exports = LiveController;