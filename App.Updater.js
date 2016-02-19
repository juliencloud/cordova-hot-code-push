define(function (require, exports, module) {

    var async = require('app/js/libs/async/lib/async');
    var FileUtils = require('app/js/utils/FileUtils');
    var AppNotifications = require('app/js/global/App.Notifications');
    var AppRouter = require('app/js/global/App.Router');
    var AppSettings = require('app/js/global/App.Settings');
    var AppEvents = require('app/js/global/App.Events');
    var AppSplashscreen = require('app/js/global/App.Splashscreen');
    var AppStrings = require('app/js/global/App.Strings');
    var FirebaseAuth = require('app/js/auth/FirebaseAuth');
	var FirebaseReader = require('app/js/data/reader/FirebaseReader');

    var AppUpdater = {};

    AppUpdater.ENABLE_CHECK_HASH = true;
    AppUpdater.ENABLE_CHECK_SIZE = false; // not necessary if ENABLE_CHECK_HASH = true

    AppUpdater.NOT_UPDATING = 'NOT_UPDATING';
    AppUpdater.RELOAD_READY = 'RELOAD_READY';

	AppUpdater.requiresRelaunch = false;

    var isEnabled = false;
    var isRunning = false;
    var isPaused = false;

    AppEvents.on('pause', function() {
        isPaused = true;
    });

    AppEvents.on('resume', function() {
        isPaused = false;
    });

    /**
     * Enable automatic updates
     *
     * @param {function} progress       Called back with (phase, done, total) during an update
     * @param {function} complete       Called back with (err, result), each time a new version is detected and processed
     */
    AppUpdater.enable = function enable(progress, complete) {
        if (isEnabled) return;
        isEnabled = true;
        progress = progress || NOOP;
        complete = complete || NOOP;
        AppUpdater.manifestFileName = 'manifest.json';
        AppUpdater.hostingDirectoryUri = FIREBASE_HOSTING + '/';
        AppUpdater.bundleDirectoryUri = cordova.file.applicationDirectory + 'www/';
        AppUpdater.live1DirectoryUri = cordova.file.dataDirectory + 'www1/';
        AppUpdater.live2DirectoryUri = cordova.file.dataDirectory + 'www2/';
        AppUpdater.liveDirectoryUri = '';
        AppUpdater.cacheDirectoryUri = '';

        // Monitor socket connection status to switch to REST when the app goes on pause (Android only)

        if (AppSettings.IS_ANDROID) {
            new Firebase(FIREBASE_DATABASE + '/.info/connected').on('value', function onvalue(snap) {
                if (snap.val()) {
                    console.log('App.Updater: now connected to Firebase via socket');
                    unbindFromREST();
                    bindToSocket();
                } else {
                    console.log('App.Updater: now disconnected from Firebase via socket, using REST');
                    unbindFromSocket();
                    bindToREST();
                }
            });
        } else {
            bindToSocket();
            AppEvents.on('pause', function onpause() {
                unbindFromSocket();
            });
            AppEvents.on('resume', function onresume() {
                bindToSocket();
            });

        }

        // If socket connection is up we subscribe to updater/hosting_version node
        var socketCallback;
        function bindToSocket() {
            if (socketCallback) return;
            socketCallback = new Firebase(FIREBASE_DATABASE + '/updater/hosting_version').on('value',
                function success(snap) {
                    console.log('App.Updater: a new hosting version has been received');
                    if (!snap || !snap.val()) {
                        console.error('App.Updater: could not read hosting version');
                    } else {
                        var hostingVersion = snap.val();
                        checkVersionAndRun(hostingVersion);
                    }
                },
                function error(err) {
                    console.error('App.Updater: there was an error fetching the hosting version from Firebase:', err);
                }
            );
        }

        function unbindFromSocket() {
            if (!socketCallback) return;
            new Firebase(FIREBASE_DATABASE + '/updater/hosting_version').off('value', socketCallback);
            socketCallback = null;
        }

        // If socket connection is down (ie when the app is on pause), we poll the updater.hosting_version node on regular intervals
        var intervalHandleREST;
        function bindToREST() {
            var ajaxReq = {};
            ajaxReq.url = FIREBASE_DATABASE + '/updater/hosting_version.json';
            ajaxReq.data = {};
            ajaxReq.data.auth = FirebaseAuth.getAuth().token;
            ajaxReq.type = 'GET';
            ajaxReq.dataType = 'json';
            ajaxReq.success = function success(result) {
                console.log('App.Updater: request to Firebase REST success with result:', result);
                if (result.error) {
                    complete(new Error('Firebase REST returned an error ' + result.error));
                } else {
                    checkVersionAndRun(result);
                }
            };
            ajaxReq.error = function error(err) {
                complete(new Error('Firebase REST Ajax error'));
            };
            ajaxReq.timeout = 10000;
            function runReq() {
                if (!isRunning) {
                    console.log('App.Updater: now requesting Firebase REST for current hosting version using url', ajaxReq.url, 'with data', ajaxReq.data);
                    $.ajax(ajaxReq);
                }
            }
            runReq();
            intervalHandleREST = setInterval(runReq, 60 * 60 * 1000); // check twice a day
        }

        function unbindFromREST() {
            if (intervalHandleREST) clearInterval(intervalHandleREST);
        }

        // Depending on the version number we got from the database, decide if we should run an update or not
        function checkVersionAndRun(hostingVersion) {
            var bef = AppSettings.APP_HYBRID_VERSION.split('.');
            var aft = hostingVersion.split('.');
            for (var i = 0, comp = ''; i < 3; i++) {
                bef[i] = (typeof bef[i] === 'undefined') ? 0 : JSON.parse(bef[i]);
                aft[i] = (typeof aft[i] === 'undefined') ? 0 : JSON.parse(aft[i]);
                comp += (aft[i] > bef[i] ? '>' : (aft[i] < bef[i] ? '<' : '='));
            }
            console.log('App.Updater: version on hosting is', hostingVersion, 'and live version is', AppSettings.APP_HYBRID_VERSION, '--> comparison is:', comp);
            switch (comp) {
                case '==>':
                case '=>=':
                case '=>>':
                case '=><':
                    console.log('App.Updater: now updating to hosting version');
                    AppNotifications.Toast.show(AppStrings.get('UPDATER_IS_UPDATE'), AppNotifications.Toast.DURATION_SHORT, AppNotifications.Toast.POSITION_BOTTOM);
                    AppUpdater.run(hostingVersion, progress, complete);
                    break;
                default:
                    console.log('App.Updater: complete with result', AppUpdater.NOT_UPDATING);
                    complete(null, AppUpdater.NOT_UPDATING);
            }
        }
    };

    /**
     * Disable automatic updates
     */
    AppUpdater.disable = function disable() {
        if (!isEnabled) return;
        isEnabled = false;
        new Firebase(FIREBASE_DATABASE + '/updater/hosting_version').off();
    };

    /**
     * Reset the app to its bundle version
     */
    AppUpdater.reset = function reset() {
        window.localStorage.removeItem('manifest');
        window.localStorage.removeItem('previous_manifest');
        window.localStorage.removeItem('route_after_reload');
        AppSplashscreen.show();
        location.reload();
    };

    /**
     * Launch an update
     *
     * @param {string} version          The version to update to ; this MUST correspond to the version of the manifest.json file on the hosting
     * @param {function} progress       Called back with progress (phase, done, total) during an update
     * @param {function} complete       Called back on completion with (err, result)
     */
    AppUpdater.run = function run(version, progress, complete) {
        if (isRunning) {
            console.warn('App.Updater: a "run" instruction was ignored because the updater is already running');
            return;
        }
        isRunning = true;

        async.auto({
            _readBundleManifest: _readBundleManifest,
            _readLiveManifest: _readLiveManifest,
            _checkDirectories: ['_readBundleManifest', '_readLiveManifest', _checkDirectories],
            _downloadHostingManifest: ['_checkDirectories', _downloadHostingManifest],
            _readHostingManifest: ['_downloadHostingManifest', _readHostingManifest],
            _listFiles: ['_readHostingManifest', _listFiles],
            _downloadNewFiles: ['_listFiles', _downloadNewFiles],
            _copyFilesFromBundle: ['_listFiles', _copyFilesFromBundle],
            _copyFilesFromLive: ['_listFiles', _copyFilesFromLive],
            _checkCacheFilesSize: ['_downloadNewFiles', '_copyFilesFromBundle', '_copyFilesFromLive', _checkCacheFilesSize],
            _checkCacheFilesHash: ['_downloadNewFiles', '_copyFilesFromBundle', '_copyFilesFromLive', _checkCacheFilesHash],
            _swapManifests: ['_checkCacheFilesSize', '_checkCacheFilesHash', _swapManifests]
        }, function onUpdateComplete(err, result) {
            if (err) {
                isRunning = false;
                AppUpdater.onError(err, complete);
            } else {
                console.log('App.Updater: complete with result', AppUpdater.RELOAD_READY);
                if (isPaused) { // if the application is in the background then we silently reload immediately and don't wait for a resume
                    isRunning = false;
                    window.localStorage.setItem('route_after_reload', JSON.stringify(AppRouter.getCurrentRoute()));
                    AppSplashscreen.show();
                    location.reload();
                } else { // if app is in the foreground then we wait for the next time the app is resumed
	                AppUpdater.requiresRelaunch = true;
	                switch (AppRouter.getCurrentRoute().route) {
		                case 'home':
		                case 'inbox':
		                case 'people':
		                case 'profile-me':
		                case 'profile':
		                case 'profile-browse':
		                case 'participants':
		                case 'follows':
			                relaunchAfterUpdate();
			                break;
		                default:
			                // We should not interrupt user right now, but wait for next opportunity.
			                break;
	                }

                    //AppEvents.on('resume', function onresume() {
                    //    isRunning = false;
                    //    window.localStorage.setItem('route_after_reload', JSON.stringify(AppRouter.getCurrentRoute()));
                    //    AppSplashscreen.show();
                    //    location.reload();
                    //});
                }
                complete(null, AppUpdater.RELOAD_READY);
            }
        });

        function _readBundleManifest(callback, results) {
            AppUpdater.onProgress('Read bundle manifest', 0, 100, progress);
            FileUtils.readAsJSON(AppUpdater.bundleDirectoryUri + AppUpdater.manifestFileName, function onreadasjson(err, result) {
                if (err) {
                    AppUpdater.onError(err, callback);
                } else {
                    AppUpdater.onProgress('Read bundle manifest', 100, 100, progress);
                    callback(null, result);
                }
            });
        }

        function _readLiveManifest(callback, results) {
            AppUpdater.onProgress('Read current manifest', 0, 100, progress);
            try {
                var liveManifest = JSON.parse(window.localStorage.getItem('manifest'));
                switch (liveManifest.root) {
                    case AppUpdater.live1DirectoryUri:
                        AppUpdater.liveDirectoryUri = AppUpdater.live1DirectoryUri;
                        AppUpdater.cacheDirectoryUri = AppUpdater.live2DirectoryUri;
                        break;
                    case AppUpdater.live2DirectoryUri:
                        AppUpdater.liveDirectoryUri = AppUpdater.live2DirectoryUri;
                        AppUpdater.cacheDirectoryUri = AppUpdater.live1DirectoryUri;
                        break;
                    case cordova.file.bundleDirectoryUri: // useless
                        AppUpdater.liveDirectoryUri = AppUpdater.bundleDirectoryUri;
                        AppUpdater.cacheDirectoryUri = AppUpdater.live1DirectoryUri;
                        break;
                    default:
                        AppUpdater.liveDirectoryUri = AppUpdater.bundleDirectoryUri;
                        AppUpdater.cacheDirectoryUri = AppUpdater.live1DirectoryUri;
                        break;
                }
                console.log({bundle: AppUpdater.bundleDirectoryUri, live1: AppUpdater.live1DirectoryUri, live2: AppUpdater.live2DirectoryUri, live: AppUpdater.liveDirectoryUri, cache: AppUpdater.cacheDirectoryUri});
                AppUpdater.onProgress('Read current manifest', 100, 100, progress);
                callback(null, liveManifest);
            } catch (err) {
                AppUpdater.onError(err, callback);
            }
        }

        function _checkDirectories(callback, results) {
            AppUpdater.onProgress('Check/create updater directories', 0, 100, progress);
            async.series([
                function _checkLiveDirectory(callback) {
                    if (AppUpdater.liveDirectoryUri !== AppUpdater.bundleDirectoryUri) {
                        // FileUtils.createDirectory only creates directories that do not exists. If exists, does nothing.
                        FileUtils.createDirectory(AppUpdater.liveDirectoryUri, function oncreatedirectory(err, result) {
                            if (err) {
                                AppUpdater.onError({error: err, directory: AppUpdater.liveDirectoryUri, step: '_checkDirectories', operation: 'FileUtils.createDirectory'}, callback);
                            } else {
                                AppUpdater.onProgress('Check/create updater directories: liveDirectoryUri' , 33, 100, progress);
                                callback(null, result);
                            }
                        });
                    } else {
                        AppUpdater.onProgress('Check/create updater directories', 33, 100, progress);
                        callback(null, null);
                    }
                },
                function _checkCacheDirectory(callback) {
                    FileUtils.createDirectory(AppUpdater.cacheDirectoryUri, function oncreatedirectory(err, result) {
                        if (err) {
                            AppUpdater.onError({error: err, directory: AppUpdater.cacheDirectoryUri, step: '_checkDirectories', operation: 'FileUtils.createDirectory'}, callback);
                        } else {
                            AppUpdater.onProgress('Check/create updater directories: create cacheDirectoryUri', 66, 100, progress);
                            callback(null, result);
                        }
                    });
                },
                function _emptyCacheDirectory(callback) {
                    FileUtils.emptyDirectory(AppUpdater.cacheDirectoryUri, function onemptydirectory(err, result) {
                        if (err) {
                            AppUpdater.onError({error: err, directory: AppUpdater.cacheDirectoryUri, step: '_checkDirectories', operation: 'FileUtils.emptyDirectory'}, callback);
                        } else {
                            AppUpdater.onProgress('Check/create updater directories: empty cacheDirectoryUri', 100, 100, progress);
                            callback(null, result);
                        }
                    });
                }
            ], function done(err, results) {
                if (err) {
                    AppUpdater.onError({error: err, step: '_checkDirectories'}, callback);
                } else {
                    AppUpdater.onProgress('Check/create updater directories', 100, 100, progress);
                    callback(null, results);
                }
            });
        }

        function _downloadHostingManifest(callback, results) {
            FileUtils.exists(
                AppUpdater.cacheDirectoryUri,
                function complete(err, result) {
                    if (err) {
                        console.log('Error in FileUtils.exists for directory', AppUpdater.cacheDirectoryUri);
                        AppUpdater.onError({error: err, step: '_downloadHostingManifest', operation: 'FileUtils.exists'}, callback);
                    } else {
                        console.log('Result for directory', AppUpdater.cacheDirectoryUri, 'exists:');
                        console.log(result);
                        AppUpdater.onProgress('Download new manifest', 0, 100, progress);
                        console.log({
                            hostingManifest: AppUpdater.hostingDirectoryUri + AppUpdater.manifestFileName,
                            cacheManifest: AppUpdater.cacheDirectoryUri + AppUpdater.manifestFileName
                        });
                        FileUtils.download(
                            AppUpdater.hostingDirectoryUri + AppUpdater.manifestFileName,
                            AppUpdater.cacheDirectoryUri + AppUpdater.manifestFileName,
                            function onProgress(done, total) {
                                console.log('progress of _downloadHostingManifest', done, total);
                                AppUpdater.onProgress('Download new manifest', done, total, progress);
                            },
                            function onComplete(err, result) {
                                if (err) {
                                    AppUpdater.onError({
                                        error: err,
                                        step: '_downloadHostingManifest',
                                        operation: 'FileUtils.download',
                                        file: AppUpdater.hostingDirectoryUri + AppUpdater.manifestFileName,
                                        target: AppUpdater.cacheDirectoryUri + AppUpdater.manifestFileName
                                    }, callback);
                                } else {
                                    AppUpdater.onProgress('Download new manifest', 100, 100, progress);
                                    callback(null, result);
                                }
                            },
                            {
                                retries: 3,
                                timeout: 0 // wait for Cordova FileTransfer timeout
                            }
                        );
                    }
                }
            );

        }

        function _readHostingManifest(callback, results) {
            AppUpdater.onProgress('Read new manifest', 0, 100, progress);
            FileUtils.readAsJSON(
                AppUpdater.cacheDirectoryUri + AppUpdater.manifestFileName,
                function onreadasjson(err, result) {
                    if (err) {
                        AppUpdater.onError({
                            error: err,
                            step: '_readHostingManifest',
                            operation: 'FileUtils.readAsJSON',
                            file: AppUpdater.cacheDirectoryUri + AppUpdater.manifestFileName
                        }, callback);
                    } else if (result.version !== version) { // Check if version in the hosting manifest.json is the same as the one in Firebase
                        AppUpdater.onError({
                            error: 'Hosting manifest version (' + result.version + ') is different from firebase version (' + version + ')',
                            step: '_readHostingManifest',
                            operation: 'FileUtils.readAsJSON',
                            databaseVersion: version,
                            hostingVersion: result.version,
                            file: AppUpdater.cacheDirectoryUri + AppUpdater.manifestFileName,
                            content: result
                        }, callback);
                    } else {
                        callback(null, result);
                    }
                    AppUpdater.onProgress('Read new manifest', 100, 100, progress);
                }
            );
        }

        function _listFiles(callback, results) {
            AppUpdater.onProgress('List new files', 0, 100, progress);
            var liveFiles = results._readLiveManifest.files;
            var hostingFiles = results._readHostingManifest.files;
            var bundleFiles = results._readBundleManifest.files;
            var toCopyFromBundle = [];
            var toCopyFromLive = [];
            var toDownload = [];
            var file;
            Object.keys(hostingFiles).forEach(function foreachfilekey(fileKey) {
                if (liveFiles && liveFiles[fileKey] && hostingFiles && hostingFiles[fileKey] && liveFiles[fileKey].hash === hostingFiles[fileKey].hash) {
                    // Hosting file is the same as the live one, copy it
                    file = liveFiles[fileKey];
                    file.key = fileKey;
                    toCopyFromLive.push(file);
                } else if (bundleFiles && bundleFiles[fileKey] && hostingFiles && hostingFiles[fileKey] && bundleFiles[fileKey].hash === hostingFiles[fileKey].hash) {
                    // File exists in bundle, copy it
                    file = bundleFiles[fileKey];
                    file.key = fileKey;
                    toCopyFromBundle.push(file);
                } else {
                    // File with the right version does not exist in bundle nor in live, download it
                    file = hostingFiles[fileKey];
                    file.key = fileKey;
                    toDownload.push(file);
                }
            });
            console.log('App.Updater: List new files --> toCopyFromBundle', toCopyFromBundle);
            console.log('App.Updater: List new files --> toCopyFromLive', toCopyFromLive);
            console.log('App.Updater: List new files --> toDownload', toDownload);
            AppUpdater.onProgress('List new files', 100, 100, progress);
            callback(null, {
                toDownload: toDownload,
                toCopyFromBundle: toCopyFromBundle,
                toCopyFromLive: toCopyFromLive
            });
        }

        function _downloadNewFiles(callback, results) {
            AppUpdater.onProgress('Download new files', 0, 100, progress);
            var toDownload = results._listFiles.toDownload, bytesLoaded = {};
            for (var i = 0, bytesToDownload = 0; i < toDownload.length; i++) bytesToDownload += toDownload[i].size;
            async.eachLimit(toDownload, 2,
                function iterator(file, callback) {
                    var distantUri = AppUpdater.hostingDirectoryUri + file.key;
                    var localUri = AppUpdater.cacheDirectoryUri + file.key;
                    FileUtils.download(distantUri, localUri,
                        function onProgress(done, total) {
                            bytesLoaded[file.key] = done;
                            AppUpdater.onProgress('Download new files', totalBytesLoaded(), bytesToDownload, progress);
                        },
                        function onComplete(err, result) {
                            if (err) {
                                AppUpdater.onError({
                                    error: err,
                                    step: '_downloadNewFiles',
                                    operation: 'FileUtils.download',
                                    distantUri: distantUri,
                                    localUri: localUri
                                }, callback);
                            } else {
                                bytesLoaded[file.key] = file.size;
                                AppUpdater.onProgress('Download new files', totalBytesLoaded(), bytesToDownload, progress);
                                callback(null, null);
                            }
                        },
                        {
                            retries: 3,
                            timeout: 0 // wait for Cordova FileTransfer timeout
                        }
                    );
                },
                function done(err, result) {
                    if (err) {
                        AppUpdater.onError(err, callback);
                    } else {
                        AppUpdater.onProgress('Download new files', 100, 100, progress);
                        callback(null, result);
                    }
                }
            );

            function totalBytesLoaded() {
                var total = 0;
                Object.keys(bytesLoaded).forEach(function foreach(key) {
                    total += bytesLoaded[key];
                });
                return total;
            }
        }

        function _copyFilesFromBundle(callback, results) {
            AppUpdater.onProgress('Copy local files (1/2)', 0, 100, progress);
            var toCopyFromBundle = results._listFiles.toCopyFromBundle;
            var countToCopy = toCopyFromBundle.length, countCopied = 0;
            async.eachLimit(toCopyFromBundle, 1,
                function iterator(file, callback) {
                    var fileUriFrom = AppUpdater.bundleDirectoryUri + file.key;
                    var fileUriTo = AppUpdater.cacheDirectoryUri + file.key;
                    FileUtils.copyFile(fileUriFrom, fileUriTo, function oncopyfile(err, result) {
                        if (err) {
                            AppUpdater.onError({
                                error: err,
                                step: '_copyFilesFromBundle',
                                operation: 'FileUtils.copyFile',
                                fileUriFrom: fileUriFrom,
                                fileUriTo: fileUriTo
                            }, callback);
                        } else {
                            countCopied++;
                            AppUpdater.onProgress('Copy local files (1/2)', countCopied, countToCopy, progress);
                            callback(null, result);
                        }
                    });
                },
                function done(err, result) {
                    if (err) {
                        AppUpdater.onError(err, callback);
                    } else {
                        AppUpdater.onProgress('Copy local files (1/2)', 100, 100, progress);
                        callback(null, result);
                    }
                }
            );
        }

        function _copyFilesFromLive(callback, results) {
            AppUpdater.onProgress('Copy local files (2/2)', 0, 100, progress);
            var toCopyFromLive = results._listFiles.toCopyFromLive;
            var countToCopy = toCopyFromLive.length, countCopied = 0;
            async.eachLimit(toCopyFromLive, 1,
                function iterator(file, callback) {
                    var fileUriFrom = AppUpdater.liveDirectoryUri + file.key;
                    var fileUriTo = AppUpdater.cacheDirectoryUri + file.key;
                    FileUtils.copyFile(fileUriFrom, fileUriTo, function oncopyfile(err, result) {
                        if (err) {
                            AppUpdater.onError({
                                error: err,
                                step: '_copyFilesFromLive',
                                operation: 'FileUtils.copyFile',
                                fileUriFrom: fileUriFrom,
                                fileUriTo: fileUriTo
                            }, callback);
                        } else {
                            countCopied++;
                            AppUpdater.onProgress('Copy local files (2/2)', countCopied, countToCopy, progress);
                            callback(null, result);
                        }
                    });
                },
                function done(err, result) {
                    if (err) {
                        AppUpdater.onError(err, callback);
                    } else {
                        AppUpdater.onProgress('Copy local files (2/2)', 100, 100, progress);
                        callback(null, result);
                    }

                }
            );
        }

        function _checkCacheFilesHash(callback, results) {
            if (AppUpdater.ENABLE_CHECK_HASH) {
                AppUpdater.onProgress('Check updated files hash', 0, 100, progress);
                var hostingFiles = results._readHostingManifest.files;
                var fileData = {};
                var comparison = true;
                var files = Object.keys(hostingFiles);
                var countToCheck = files.length, countChecked = 0;
                async.eachSeries(
                    Object.keys(hostingFiles),
                    function iterator(fileKey, callback) {
                        fileData[fileKey] = {hashBefore: hostingFiles[fileKey].hash};
                        FileUtils.hash(AppUpdater.cacheDirectoryUri + fileKey, function onhash(err, hash) {
                                if (err) {
                                    AppUpdater.onError({
                                        error: err,
                                        step: '_checkCacheFilesHash',
                                        operation: 'FileUtils.hash',
                                        file: AppUpdater.cacheDirectoryUri + fileKey
                                    }, callback);
                                } else {
                                    fileData[fileKey].hashAfter = hash;
                                    fileData[fileKey].comparison = (fileData[fileKey].hashBefore === fileData[fileKey].hashAfter);
                                    if (!fileData[fileKey].comparison) console.error('Hash inconsistent!! -->', fileKey, fileData[fileKey]);
                                    comparison &= fileData[fileKey].comparison;
                                    countChecked++;
                                    AppUpdater.onProgress('Check updated files hash', countChecked, countToCheck, progress);
                                    callback(null, fileData[fileKey].comparison);
                                }
                            }
                        );
                    },
                    function done(err, results) {
                        AppUpdater.onProgress('Check updated files hash', 100, 100, progress);
                        if (err) {
                            AppUpdater.onError(err, callback);
                        } else {
                            if (comparison) {
                                callback(null, comparison);
                            } else {
                                AppUpdater.onError('File hashes between cache and hosting manifest are inconsistent.', callback);
                            }
                        }
                    }
                );
            } else {
                callback(null, null);
            }
        }

        function _checkCacheFilesSize(callback, results) {
            if (AppUpdater.ENABLE_CHECK_SIZE) {
                AppUpdater.onProgress('Check updated files size', 0, 100, progress);
                var hostingFiles = results._readHostingManifest.files;
                var fileData = {};
                var comparison = true;
                var files = Object.keys(hostingFiles);
                var countToCheck = files.length, countChecked = 0;
                async.eachSeries(
                    Object.keys(hostingFiles),
                    function iterator(fileKey, callback) {
                        fileData[fileKey] = {sizeBefore: hostingFiles[fileKey].size};
                        FileUtils.getSize(AppUpdater.cacheDirectoryUri + fileKey, function ongetsize(err, size) {
                                if (err) {
                                    AppUpdater.onError({
                                        error: err,
                                        step: '_checkCacheFilesSize',
                                        operation: 'FileUtils.getSize',
                                        file: AppUpdater.cacheDirectoryUri + fileKey
                                    }, callback);
                                } else {
                                    fileData[fileKey].sizeAfter = size;
                                    fileData[fileKey].comparison = (fileData[fileKey].sizeBefore === fileData[fileKey].sizeAfter);
                                    if (!fileData[fileKey].comparison) console.error('Size inconsistent!! -->', fileKey, fileData[fileKey]);
                                    comparison &= fileData[fileKey].comparison;
                                    countChecked++;
                                    AppUpdater.onProgress('Check updated files size', countChecked, countToCheck, progress);
                                    callback(null, fileData[fileKey].comparison);
                                }
                            }
                        );
                    },
                    function done(err, results) {
                        AppUpdater.onProgress('Check updated files size', 100, 100, progress);
                        if (err) {
                            callback(err);
                        } else {
                            if (comparison) {
                                callback(null, comparison);
                            } else {
                                callback('File sizes between cache and hosting manifest are inconsistent.');
                            }
                        }
                    }
                );
            } else {
                callback(null, null);
            }
        }

        function _swapManifests(callback, results) {
            AppUpdater.onProgress('Getting ready to reload', 0, 100, progress);
            var hostingManifest = results._readHostingManifest;
            hostingManifest.root = AppUpdater.cacheDirectoryUri;
            window.localStorage.setItem('manifest', JSON.stringify(hostingManifest));
            window.localStorage.setItem('previous_manifest', JSON.stringify(results._readLiveManifest));
            AppUpdater.onProgress('Getting ready to reload', 100, 100, progress);
            callback(null, null);
        }
    };

    AppUpdater.onProgress = function onProgress(phase, done, total, callback) {
        console.log('App.Updater:', phase, '-->', Math.round((done / total) * 100) + '%');
        if (callback) callback(phase, done, total);
    };

    AppUpdater.onNotUpdating = function onNotUpdating(callback) {
        if (callback) callback(null, AppUpdater.NOT_UPDATING);
    };

    AppUpdater.onReloadReady = function onReloadRead(callback) {
        if (callback) callback(null, AppUpdater.RELOAD_READY);
    };

    AppUpdater.onError = function onError(err, callback) {
        console.error('App.Updater: error', err);
        if (callback) callback(err);
    };

	AppUpdater.checkRelaunchAfterUpdate = function checkRelaunchAfterUpdate() {
		if (AppUpdater.requiresRelaunch) {
			relaunchAfterUpdate();
			return true;
		} else {
			return false;
		}
	};

	function relaunchAfterUpdate() {
		FirebaseReader.once({
			ref: FirebaseReader.ref('/overlays/relaunch_after_update/'),
			event: 'value'
		}, function onvalue(err, snap) {
			if (!err) {
				var val = snap.val();
				AppNotifications.relaunchAfterUpdate.warn(val, function onOK() {
					AppUpdater.reload();
				});
			}
		});
	}

	AppUpdater.reload = function reload() {
		isRunning = false;
		window.localStorage.setItem('route_after_reload', JSON.stringify(AppRouter.getCurrentRoute()));
		AppSplashscreen.show();
		location.reload();
	};

    module.exports = AppUpdater;
});
