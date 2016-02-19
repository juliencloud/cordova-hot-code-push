define(function (require, exports, module) {

    var async = require('app/js/libs/async/lib/async');
    var sparkmd5 = require('app/js/libs/spark-md5/spark-md5');

    var FileUtils = {};

    var CONSOLE_LOG = false;

    /**
     * Convert a local URI to a filesystem entry
     *
     * @param localUri
     * @param {function} complete       Called back on completion with (err, entry)
     */
    FileUtils.getEntry = function getEntry(localUri, complete) {
        window.resolveLocalFileSystemURL(localUri,
            function success(entry) {
                complete(null, entry);
            },
            function error(err) {
                complete(err);
            }
        );
    };

    /**
     * Download a remote file to the local filesystem
     *
     * @param {string} distantUri           The remote URI to download
     * @param {string} localUri             The local URI to store the file
     * @param {function} progress           Called on progress with (done, total)
     * @param {function} complete           Called on completion with (err, null)
     * @param {object} [options]            Optional options
     * @param {number} [options.retries=1]  Number of retries
     * @param {number} [options.timeout=0]  Total timeout before calling complete(err). Zero means no timeout
     */
    FileUtils.download = function download(distantUri, localUri, progress, complete, options) {
        options = options || {};
        options.retries = options.retries || 1;
        options.timeout = options.timeout || 0;
        var transfer = new FileTransfer();
        transfer.onprogress = function onprogress(event) {
            progress(event.loaded, event.total);
        };
        FileUtils.createParentDirectory(localUri,
            function onCreateParentDirectory(err, entry) {
                if (err) {
                    complete(err);
                } else {
                    var hasCompleted = false, hasTimedOut = false;
                    if (options.timeout > 0) {
                        setTimeout(function timeout() {
                            if (!hasCompleted) {
                                hasTimedOut = true;
                                transfer.abort(); // will throw transfer.onerror
                            }
                        }, options.timeout);
                    }
                    async.retry(options.retries,
                        function retryPayload(callback, results) {
                            transfer.download(
                                encodeURI(distantUri),
                                localUri,
                                function onDownloadSuccess() {
                                    if (!hasTimedOut) {
                                        hasCompleted = false;
                                        callback(null, null);
                                    }
                                },
                                function onDownloadError(err) {
                                    callback(err);
                                },
                                false,
                                {
                                    headers: {
                                        'if-Modified-Since': 0
                                    }
                                }
                            );
                        },
                        complete
                    );
                }
            }
        );
    };

    /**
     * Delete a file/dir from the file system
     *
     * @param {string} localUri     The URI to delete
     * @param {function} complete   Called on completion with (err, null)
     */
    FileUtils.remove = function remove(localUri, complete) {
        FileUtils.getEntry(localUri,
            function onGetEntry(err, entry) {
                if (err && err.code && err.code === FileError.NOT_FOUND_ERR) {
                    complete(null, null); // file/dir did not exist so it is already removed
                } else if (err) {
                    complete(err); // any other error
                } else {
                    entry.remove(
                        function onRemoveSuccess() {
                            complete(null, null);
                        },
                        function onRemoveError(err) {
                            complete(err);
                        }
                    );
                }

            }
        );
    };

    /**
     * Check if an URI points to an existing file/directory
     *
     * @param {string} localUri         The URI to check
     * @param {function} complete       Called back on completion with (err, result),
     *                                      result = the entry if it exists and false otherwise
     */
    FileUtils.exists = function exists(localUri, complete) {
        FileUtils.getEntry(localUri,
            function onGetEntry(err, result) {
                if (err && err.code && err.code === FileError.NOT_FOUND_ERR) {
                    complete(null, false);
                } else if (err) {
                    complete(err);
                } else {
                    complete(null, result);
                }
            }
        );
    };

    /**
     * Create a directory, including all missing intermediate directories as necessary
     *
     * @param {string} directoryUri     The directory to create
     * @param {function} complete       Called on completion with (err, result)
     */
    FileUtils.createDirectory = function createDirectory(directoryUri, complete) {
        var parts = directoryUri.replace(cordova.file.dataDirectory, '').split('/').filter(function filterFunction(item) {
            return item;
        });
        FileUtils.getEntry(cordova.file.dataDirectory,
            function onGetEntry(err, initEntry) {
                if (err) {
                    complete(err);
                } else {
                    var entry = initEntry;
                    async.eachSeries(
                        parts,
                        function iterator(part, callback) {
                            entry.getDirectory(part, {create: true, exclusive: false},
                                function success(subEntry) {
                                    entry = subEntry;
                                    callback(null, entry);
                                },
                                function error(err) {
                                    callback(err);
                                }
                            );
                        },
                        function done(err, results) {
                            complete(err, entry);
                        }
                    );
                }
            }
        );
    };

    /**
     * Create a directory in cache, including all missing intermediate directories as necessary
     *
     * @param {string} directoryUri     The directory to create
     * @param {function} complete       Called on completion with (err, result)
     */
    FileUtils.createCacheDirectory = function createDirectory(directoryUri, complete) {
        var parts = directoryUri.replace(cordova.file.cacheDirectory, '').split('/').filter(function filterFunction(item) {
            return item;
        });
        if (CONSOLE_LOG) console.log('FileUtils: parts', parts);
        FileUtils.getEntry(cordova.file.cacheDirectory,
            function onGetEntry(err, initEntry) {
                if (err) {
                    complete(err);
                } else {
                    var entry = initEntry;
                    async.eachSeries(
                        parts,
                        function iterator(part, callback) {
                            entry.getDirectory(part, {create: true, exclusive: false},
                                function success(subEntry) {
                                    if (CONSOLE_LOG) console.log('FileUtils.createCacheDirectory directory successfully created', part, subEntry);
                                    entry = subEntry;
                                    callback(null, entry);
                                },
                                function error(err) {
                                    callback(err);
                                }
                            );
                        },
                        function done(err, results) {
                            complete(err, entry);
                        }
                    );
                }
            }
        );
    };

    /**
     * Create the parent directory (recursively) for a file URI
     *
     * @param {string} fileUri          The file URI
     * @param {function} complete       Called back on completion with (err, result)
     */
    FileUtils.createParentCacheDirectory = function createParentDirectory(fileUri, complete) {
        if (fileUri.substring(-1) === '/') {
            complete('FileUtils.createParentDirectory: The URI ends with "/" but should be the URI of a file');
        } else {
            var directoryUri = fileUri.substring(0, fileUri.lastIndexOf('/'));
            FileUtils.createCacheDirectory(directoryUri, complete);
        }
    };

    /**
     * Create the parent directory (recursively) for a file URI
     *
     * @param {string} fileUri          The file URI
     * @param {function} complete       Called back on completion with (err, result)
     */
    FileUtils.createParentDirectory = function createParentDirectory(fileUri, complete) {
        if (fileUri.substring(-1) === '/') {
            complete('FileUtils.createParentDirectory: The URI ends with "/" but should be the URI of a file');
        } else {
            var directoryUri = fileUri.substring(0, fileUri.lastIndexOf('/'));
            FileUtils.createDirectory(directoryUri, complete);
        }
    };

    /**
     * Empty the contents of a directory, including all files and subdirectories, recursively.
     * The directory itself is not removed.
     *
     * @param {string} directoryUri     The directory URI to empty
     * @param {function} complete       Called back on completion with (err, null)
     */
    FileUtils.emptyDirectory = function emptyDirectory(directoryUri, complete) {

        async.auto({
            _getDirectoryEntry: _getDirectoryEntry,
            _getDirectorySubEntries: ['_getDirectoryEntry', _getDirectorySubEntries],
            _removeAllSubEntries: ['_getDirectorySubEntries', _removeAllSubEntries]
        }, complete);

        function _getDirectoryEntry(callback, results) {
            FileUtils.getEntry(directoryUri,
                function onGetEntry(err, entry) {
                    if (err) {
                        callback(err);
                    } else if (entry instanceof DirectoryEntry) {
                        callback(null, entry);
                    } else {
                        callback('URI is not a directory');
                    }
                }
            );
        }

        function _getDirectorySubEntries(callback, results) {
            var reader = results._getDirectoryEntry.createReader();
            reader.readEntries(
                function success(entries) {
                    callback(null, entries);
                },
                function error(err) {
                    callback(err);
                }
            );
        }

        function _removeAllSubEntries(callback, results) {
            async.eachSeries(
                results._getDirectorySubEntries,
                function iterator(entry, callback) {
                    if (entry instanceof DirectoryEntry) {
                        entry.removeRecursively(
                            function success() {
                                callback(null, null);
                            },
                            function error(err) {
                                callback(err);
                            }
                        );
                    } else if (entry instanceof FileEntry) {
                        entry.remove(
                            function success() {
                                callback(null, null);
                            },
                            function error(err) {
                                callback(err);
                            }
                        );
                    } else {
                        callback('This entry could not be processed', entry);
                    }
                },
                callback
            );
        }
    };

    /**
     * Read a text file from disk to a string
     *
     * @param {string} textUri      The URI of the file to read
     * @param {function} complete   Called back on completion with (err, string}
     */
    FileUtils.readAsText = function readText(textUri, complete) {

        async.auto({
            _getFileEntry: _getFileEntry,
            _getFile: ['_getFileEntry', _getFile],
            _readFile: ['_getFile', _readFile]
        }, function done(err, results) {
            complete(err, results._readFile);
        });

        function _getFileEntry(callback, results) {
            FileUtils.getEntry(textUri, callback);
        }

        function _getFile(callback, results) {
            results._getFileEntry.file(
                function success(file) {
                    callback(null, file);
                },
                function error(err) {
                    callback(err);
                }
            );
        }

        function _readFile(callback, results) {
            var reader = new FileReader();
            reader.onloadend = function onloadend(event) {
                if (event.target.result) {
                    callback(null, event.target.result);
                } else {
                    callback(null, null);
                }
            };
            reader.onerror = function onerror(err) {
                callback(err);
            };
            reader.readAsText(results._getFile);
        }
    };

    /**
     * Read a binary file from disk to a binary string
     *
     * @param {string} fileUri      The URI of the file to read
     * @param {function} complete   Called back on completion with (err, binary string}
     */
    FileUtils.readAsBinaryString = function readBinaryString(fileUri, complete) {

        async.auto({
            _getFileEntry: _getFileEntry,
            _getFile: ['_getFileEntry', _getFile],
            _readFile: ['_getFile', _readFile]
        }, function done(err, results) {
            complete(err, results._readFile);
        });

        function _getFileEntry(callback, results) {
            FileUtils.getEntry(fileUri, callback);
        }

        function _getFile(callback, results) {
            results._getFileEntry.file(
                function success(file) {
                    callback(null, file);
                },
                function error(err) {
                    callback(err);
                }
            );
        }

        function _readFile(callback, results) {
            var reader = new FileReader();
            reader.onloadend = function onloadend(event) {
                if (event.target.result) {
                    callback(null, event.target.result);
                } else {
                    callback(null, null);
                }
            };
            reader.onerror = function onerror(err) {
                callback(err);
            };
            reader.readAsBinaryString(results._getFile);
        }
    };

    /**
     * Read a binary file from disk to a binary string
     *
     * @param {string} fileUri      The URI of the file to read
     * @param {function} complete   Called back on completion with (err, buffer}
     */
    FileUtils.readAsArrayBuffer = function readAsArrayBuffer(fileUri, complete) {

        async.auto({
            _getFileEntry: _getFileEntry,
            _getFile: ['_getFileEntry', _getFile],
            _readFile: ['_getFile', _readFile]
        }, function done(err, results) {
            complete(err, results._readFile);
        });

        function _getFileEntry(callback, results) {
            FileUtils.getEntry(fileUri, callback);
        }

        function _getFile(callback, results) {
            results._getFileEntry.file(
                function success(file) {
                    callback(null, file);
                },
                function error(err) {
                    callback(err);
                }
            );
        }

        function _readFile(callback, results) {
            var reader = new FileReader();
            reader.onloadend = function onloadend(event) {
                if (event.target.result) {
                    callback(null, event.target.result);
                } else {
                    callback(null, null);
                }
            };
            reader.onerror = function onerror(err) {
                callback(err);
            };
            reader.readAsArrayBuffer(results._getFile);
        }
    };

    /**
     * Read a JSON file from disk to a Javascript object
     *
     * @param {string} jsonUri      The URI of the file to read
     * @param {function} complete   Called back on completion with (err, object}
     */
    FileUtils.readAsJSON = function readJSON(jsonUri, complete) {

        FileUtils.readAsText(jsonUri, function onReadAsText(err, result) {
            if (err) {
                complete(err);
            } else {
                try {
                    complete(null, JSON.parse(result));
                } catch (errObj) {
                    complete(errObj);
                }
            }
        });
    };

    /**
     * List all FileEntries from a directory URI
     *
     * @param {string} directoryUri     The directory URI to list
     * @param {function} complete       Called back on completion with (err, entries)
     */
    FileUtils.listFiles = function listFiles(directoryUri, complete) {

        window.resolveLocalFileSystemURL(directoryUri,
            function success(dirEntry) {
                if (dirEntry instanceof DirectoryEntry) {
                    var reader = dirEntry.createReader();
                    reader.readEntries(
                        function success(entries) {
                            entries.filter(function filterFunction(entry) {
                                return entry instanceof FileEntry;
                            });
                            complete(null, entries);
                        },
                        function error(err) {
                            complete(err);
                        }
                    );
                } else {
                    complete('This URI is not a directory');
                }
            },
            function error(err) {
                complete(err);
            }
        );
    };

    /**
     * Copy a file/directory from one URI to another
     *
     * @param {string} fileUriFrom      The URI to copy from
     * @param {string} fileUriTo        The URI to copy to
     * @param {function} complete       Called back on completion with (err, entryTo)
     */
    FileUtils.copyFile = function copyFile(fileUriFrom, fileUriTo, complete) {

        async.auto({
            _getFileEntryFrom: _getFileEntryFrom,
            _createParentDirectoryTo: _createParentDirectoryTo,
            _copyFile: ['_getFileEntryFrom', '_createParentDirectoryTo', _copyFile]
        }, complete);

        function _getFileEntryFrom(callback, results) {
            FileUtils.getEntry(fileUriFrom, callback);
        }

        function _createParentDirectoryTo(callback, results) {
            FileUtils.createParentDirectory(fileUriTo, callback);
        }

        function _copyFile(callback, results) {
            results._getFileEntryFrom.copyTo(
                results._createParentDirectoryTo,
                fileUriTo.substring(fileUriTo.lastIndexOf('/') + 1), // new file name
                function success(entry) {
                    callback(null, entry);
                },
                function error(errObj) {
                    callback(errObj);
                }
            );
        }
    };

    /**
     * Compute the MD5 hash of a file
     *
     * @param {string} localUri     The URI of the file
     * @param {function} complete   Called on completion with (err, hash)
     */
    FileUtils.hash = function hash(localUri, complete) {
        FileUtils.readAsArrayBuffer(localUri, function onReadAsArrayBuffer(err, buff) {
            if (err) {
                complete(err);
            } else {
                try {
                    complete(null, sparkmd5.ArrayBuffer.hash(buff, false));
                } catch (errObj) {
                    complete(errObj);
                }
            }
        });
    };

    FileUtils.hashCode = function hashCode(string) {
        var hash = 0, i, chr, len;
        if (string.length === 0) return hash;
        for (i = 0, len = string.length; i < len; i++) {
            chr = string.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0; // Convert to 32bit integer
        }
        return hash;
    };

    /**
     * Retrieves the size in bytes of a file
     *
     * @param {string} localUri     The URI of the file
     * @param {function} complete   Called on completion with (err, size)
     */
    FileUtils.getSize = function getSize(localUri, complete) {
        FileUtils.getEntry(localUri, function onGetEntry(err, entry) {
            entry.file(
                function onFileSuccess(file) {
                    complete(null, file.size);
                },
                function onFileError(err) {
                    complete(err);
                }
            );
        });
    };

    module.exports = FileUtils;
});