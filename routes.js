/**
 * Created by 3er on 1/5/15.
 */

// Since Node 0.8, .existsSync() moved from path to fs:
var path = require('path');
var fs = require('fs');
var walk = require('walk')

var PRIVATE = require('./config/private')
var async = require('async')
var _existsSync = fs.existsSync || path.existsSync;

var _ = require('underscore');
var moment = require('moment');
var formidable = require('formidable');

var chokidar = require('chokidar');

// qiniu
var qiniu = require('qiniu')
qiniu.conf.ACCESS_KEY = PRIVATE.qiniu.access_key
qiniu.conf.SECRET_KEY = PRIVATE.qiniu.secret_key

var compress = require('./compress')

var generateURL = function (ver, key) {
    var deadline = Math.floor(Date.now() / 1000) + ver.expiration;
    var link = encodeURI('http://' + ver.domain + '/' + key + '?e=' + deadline);
    var token = qiniu.conf.ACCESS_KEY + ':' +
        qiniu.util.base64ToUrlSafe(qiniu.util.hmacSha1(link, qiniu.conf.SECRET_KEY));
    return link +
        '&token=' + token;
}

var generateInfoURL = function (ver, key) {
    var deadline = Math.floor(Date.now() / 1000) + ver.expiration;
    var link = encodeURI('http://' + ver.domain + '/' + key + '?avinfo&e=' + deadline);
    var token = qiniu.conf.ACCESS_KEY + ':' +
        qiniu.util.base64ToUrlSafe(qiniu.util.hmacSha1(link, qiniu.conf.SECRET_KEY));
    return link +
        '&token=' + token;
}

var generateCompressScripts = function (path, oped) {
    var cmd = compress.generate(path, oped);
    // console.log(cmd);
    return cmd;
}
var deleteAsync = function (key, cb) {
    var rmQiniu = function (reso, key, next) {
        var client = new qiniu.rs.Client();
        client.remove(PRIVATE.qiniu[reso].bucket, key, function (err) {
            if (err) {
                next(err)
            }
            else {
                //console.log('a')
                next()
            }
        });
    };

    var rmLocal = function (reso, key, next) {
        var filePath = PRIVATE.dir.rsync + reso + '/' + key;
        fs.unlink(filePath, function (err) {
            if (err) {
                next(err);
            }
            else {
                // console.log('b')
                next();
            }
        });
    };
    async.parallel([
            function (next) {
                rmQiniu('origin', key, next)
            }, function (next) {
                rmQiniu('high', key, next)
            }, function (next) {
                rmQiniu('medium', key, next)
            }, function (next) {
                rmQiniu('low', key, next)
            },
            function (next) {
                rmLocal('origin', key, next)
            }, function (next) {
                rmLocal('high', key, next)
            }, function (next) {
                rmLocal('medium', key, next)
            }, function (next) {
                rmLocal('low', key, next)
            }
        ], cb
    );


}

var deleteList = [];


module.exports = function (app) {
    var testAdd = PRIVATE.dir.rsync + 'low/';

    var watcher = chokidar.watch(testAdd, {persistent: true});
    //watcher.add(['/1.txt', '2.txt', '3.txt']);
    watcher.on('add', function (path) {
        var testArr = _.map(deleteList, function (item) {
            return testAdd + item;
        });
        var judger = _.find(testArr, function (asis) {
            return asis === path;
        });

        if (judger !== undefined) {
            var delKey = path.replace(/^.*[\/]/, '');
            deleteAsync(delKey, function (err, result) {
                if (err) {
                    console.log(err);
                }
                //reserved console log which indicates the delete process
                console.log('delete success: ' + path);
                var index = deleteList.indexOf(delKey);

                if (index > -1) {
                    deleteList.splice(index, 1);
                }
            });
        }
    });


    // http api
    app.get('/video/opeds', function (req, res) {
        res.status(200).json(PRIVATE.opeds);
    });

    app.post('/video/upload', function (req, res) {
        var dir = PRIVATE.dir;
        // headers
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Content-Disposition', 'inline; filename="files.json"');

        // init
        var ret = {files: []};
        var form = new formidable.IncomingForm();
        form.encoding = 'utf-8';
        // 把mov转为mp4
        form.keepExtensions = false;

        var command = new compress.oped();

        // make upload directory
        form.uploadDir = dir.upload + moment().format('YYYYMMDDhhmmss/');

        // TODO: Exception判断
        fs.mkdirSync(form.uploadDir);


        // handle uplaod
        form.on('fileBegin', function (name, file) {
            file.name = file.name.replace(/-/g, "_").replace(/\.[^/.]+$/, "") + '.mp4'
            //console.log(file.name)
            file.path = form.uploadDir + file.name;

            ret.files.push({name: file.name, path: file.path});
            if (_existsSync(file.path) || _existsSync(PRIVATE.dir.rsync + 'origin/' + file.name)) {
                ret.files[0].error = '文件已存在，不能覆盖';
                //console.log(ret.files[0].error);
            }
        }).on('field', function (name, value) {
            // 生成片头片尾命令
            command[name] = value;
        }).on('file', function (name, file) {
//                console.log(file.path);
            ret.files[0].size = file.size;
        }).on('aborted', function () {
            ret.files.forEach(function (file) {
                fs.unlinkSync(file.path);
            });
            // TODO: Exception判断
            fs.rmdirSync(path.dirname(ret.files[0].path));
            console.log('删除文件夹')
        }).on('error', function (e) {
            ret.files[0].error = e;
            // console.log(e);
        }).on('progress', function (bytesReceived) {
        }).on('end', function () {
            var error = ret.files[0].error;
            res.status(error ? 500 : 201).json(ret);
            if (!error) {
                //console.log(ret.files[0].path)
                // console.log(command);
                if (_existsSync(form.uploadDir)) {
                    generateCompressScripts(ret.files[0].path, command)
                }
            }
        }).parse(req);
    });

    app.get('/qiniu/link/origin/:key', function (req, res) {
//        console.log(req.param('ver'));
//        console.log(req.param('key'));
        var l = generateURL(PRIVATE.qiniu['origin'], req.param('key'), qiniu);
        res.redirect(l);
    });

    app.get('/qiniu/info/origin/:key', function (req, res) {
//        console.log(req.param('ver'));
//        console.log(req.param('key'));
        var l = generateInfoURL(PRIVATE.qiniu['origin'], req.param('key'), qiniu);
        res.redirect(l);
    });

    app.post('/qiniu/list', function (req, res) {
        var marker = null;
        qiniu.rsf.listPrefix(PRIVATE.qiniu.origin.bucket, '', marker, 999999, function (err, ret) {
            if (err) {
                res.status(500).send(err);
                console.log(err);
            } else {
                // process ret.marker & ret.items
//            console.log(ret.marker);
//            console.log(ret.items);

                var retr = _.chain(ret.items)
                    .sortBy(function (item) {
                        return -item.putTime
                    })
//                    .each(function (item) {
//                        item.link = generateURL(item, qiniu, PRIVATE.origin)
//                    })
                    .value();
                res.status(200).send({
                    current: 1,
                    rowCount: -1,
                    rows: retr,
                    total: retr.length
                });
            }
        });
    });
    app.delete('/qiniu/list/:key', function (req, res) {
        var key = req.params.key;
        deleteAsync(key, function (err) {

            if (err) console.log(err);
            res.status(200);
            res.end('delete success')

        });


    });

    app.post('/video/compressing/:key', function (req, res) {
        deleteList.push(req.params.key);
        _.uniq(deleteList);
        res.status(201);
        res.end();
    });

    app.post('/video/compressing', function (req, res) {
        // mock
        var arr = [];
        var filters = [
            '.DS_Store', 'command',
            'h.list', 'm.list', 'l.list',
            'h.mp4', 'm.mp4', 'l.mp4',
            'outputh.mp4', 'outputm.mp4', 'outputl.mp4'
        ]

        var options = {
            listeners: {
                names: function (root, nodeNamesArray) {
                    _.chain(nodeNamesArray)
                        .flatten()
                        .difference(filters)
                        .reject(function (item) {
                            return (item.length == 14) && (item.indexOf('201') == 0);
                        })
                        .each(function (item) {
                            arr.push({key: item, progress: "compress"})
                        });
                }, directories: function (root, dirStatsArray, next) {
                    next();
                }, files: function (root, fileStats, next) {
                    next();
                }, errors: function (root, nodeStatsArray, next) {
                    next();
                }
            }
        };

        walker = walk.walkSync(PRIVATE.dir.upload, options);

//        console.log("all done");

        var retr = arr;
        var tempKeys = _.object(deleteList, ['']);
        var temp = _.filter(retr, function (item) {
            return !(item.key in tempKeys);
        });
//            _.chain(arr)
//            .sortBy(function (item) {
//                return item.progress;
//            })
//            .value();

        res.status(200).send({
            current: 1,
            rowCount: -1,
            rows: temp,
            total: 2
        });
    });
}