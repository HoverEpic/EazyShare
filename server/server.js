'use strict';
//init app
const config = require('config');
const mysql = require('mysql');
const xss = require("xss");
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const fileUpload = require('jquery-file-upload-middleware');
const path = require('path');
const auth = require('basic-auth');
const fs = require('fs-extra');
const moment = require('moment');
const async = require('async');
const archiver = require('archiver');
const Progress = require('progress-stream');
const EventEmitter = require('events');
const wget = require('wget-improved');
const ffmpeg = require('fluent-ffmpeg');

class ProgressEmitter extends EventEmitter {

    emit(name, e) {
        this.last = e;
        super.emit(...arguments);
    }

    getLast() {
        return this.last || {percentage: 0, transferred: 0, length: 0, remaining: 0, eta: 0, runtime: 0, delta: 0, speed: 0};
    }
}
;

// override console
var log = console.log;
console.log = function () {
    var first_parameter = arguments[0];
    var other_parameters = Array.prototype.slice.call(arguments, 1);
    log.apply(console, [new Date().toISOString().replace('T', ' ').substr(0, 19) + " > " + first_parameter].concat(other_parameters));
};
var error = console.error;
console.error = function () {
    var first_parameter = arguments[0];
    var other_parameters = Array.prototype.slice.call(arguments, 1);
    error.apply(console, [new Date().toISOString().replace('T', ' ').substr(0, 19) + " > " + first_parameter].concat(other_parameters));
};

// Constants TODO config env
const PORT = config.get('Config.Server.port');
const HOST = config.get('Config.Server.host');
const PATH = config.get('Config.Paths.root_share');
const AUTH = config.get('Config.Users');

var progressBars = new Map();
var command = ffmpeg();

var app = express();

// enable POST request decoding
app.use(bodyParser.json());     // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({// to support URL-encoded bodies
    extended: true
}));

// templating
app.engine('html', require('ejs').renderFile);
app.set('view engine', 'html');

//security
app.use(helmet());
app.disable('x-powered-by');

//upload
var uploadDir = null;
if (config.get('Config.Upload.enable')) {
    uploadDir = PATH + '/uploads';
    //create folder if not exists
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir);
    }
    //config
    fileUpload.configure({
        uploadDir: uploadDir,
        uploadUrl: '/upload'
    });
    app.use('/upload', fileUpload.fileHandler());
}
download
var downloadDir = null;
if (config.get('Config.Download.enable')) {
    downloadDir = PATH + '/downloads';
    //create folder if not exists
    if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir);
    }
}
//transcoder
var transcoderDir = null;
if (config.get('Config.Transcoder.enable')) {
    transcoderDir = PATH + '/transcoded';
    //create folder if not exists
    if (!fs.existsSync(transcoderDir)) {
        fs.mkdirSync(transcoderDir);
    }
}

var dbConfig = config.get('Config.Mysql');
var pool = mysql.createPool(dbConfig);

pool.getConnection(function (err, connection) {
    if (err)
        throw err;
    console.log("Connected to MYSQL server !");
    //create the table if not exist
    pool.query(['CREATE TABLE IF NOT EXISTS shares',
        '( `id` int(11) NOT NULL AUTO_INCREMENT,',
        '`file` text NOT NULL,',
        '`token` text NOT NULL,',
        '`size` varchar(10) NOT NULL,',
        '`creator` int(11) DEFAULT NULL,',
        '`create_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,',
        '`limit_time` timestamp NULL DEFAULT NULL,',
        '`limit_download` int(11) DEFAULT -1,',
        '`password` varchar(50) DEFAULT NULL,',
        '`active` tinyint(1) NOT NULL DEFAULT 1,',
        'PRIMARY KEY (`id`))',
        'ENGINE=InnoDB DEFAULT CHARSET=latin1'].join(' '), function (err, rows, fields) {
        if (err)
            throw err;

        //count shares
        pool.query('SELECT COUNT(*) AS `count` FROM shares WHERE `active` = 1', function (err, rows, fields) {
            if (err)
                throw err;
            console.log(rows[0].count + " registered shares !");
        });
    });
    //create the history if not exist
    pool.query(['CREATE TABLE IF NOT EXISTS download_history',
        '( `id` int(11) NOT NULL AUTO_INCREMENT,',
        '`file` text NOT NULL,',
        '`id_share` int(11) NOT NULL,',
        '`address` varchar(50) NOT NULL,',
        '`date` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,',
        'PRIMARY KEY (`id`))',
        'ENGINE=InnoDB DEFAULT CHARSET=latin1'].join(' '), function (err, rows, fields) {
        if (err)
            throw err;
    });
    //close limited downloads, shedule
    console.log("Ready to handle queries.");
    connection.release();
});

// DEBUG
//pool.on('acquire', function (connection) {
//  console.log('Connection %d acquired', connection.threadId);
//});
//pool.on('connection', function (connection) {
//  connection.query('SET SESSION auto_increment_increment=1')
//});
//pool.on('enqueue', function () {
//  console.log('Waiting for available connection slot');
//});
//pool.on('release', function (connection) {
//  console.log('Connection %d released', connection.threadId);
//});

// App

// the index, A GREAT BIG DENIED PAGE
app.get('/', function (req, res) {
    res.status(404).send();
});

// the create link page, accessible by admins, display files and folders in /share
app.get('/share', function (req, res) {
    check_auth(req, res, function (result) {
        if (result)
            res.sendFile(path.join(__dirname + '/public/share.html'));
        else
            res.status(403).send();
    });
});

// download the file by it's token (token)
app.get('/download/:token', function (req, res) {
    var token = req.params.token;
    var direct = req.query.direct || true;
    var password = req.query.password || null;
    var file = req.query.path || false;
    token = xss(token);
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    if (file) { // in this case, an admin is downloading a file
        check_auth(req, res, function (connected) {
            if (connected && file) {
                var split = file.split("/");
                var name = split[split.length - 1];

                console.log('<' + ip + '> Starting direct download: ' + file);
                var stream = fs.createReadStream(file, {bufferSize: 64 * 1024});
                var stat = fs.statSync(file);
                res.setHeader('Content-disposition', 'attachment; filename=' + name);
                res.setHeader('Content-Length', stat.size);
                stream.pipe(res);

                stream.on('end', () => {
                    console.log('<' + ip + '> Finish direct download: ' + file);
                    res.end();
                });

                req.on('close', () => {
                    console.log('<' + ip + '> Closed download: ' + file);
                    stream.close();
                    res.end();
                });
            }
        });
    } else { // in this case, the user is not an admin, the token is used
        get_share_by_token(token, function (result) {
            if (!result)
                res.status(404).send();
            else {
                //check if file exists
                if (!fs.existsSync(result.file)) {
                    res.status(404).send();
                    remove_share("(" + result.id + ")", function (result2) {
                        if (result2)
                            console.log("share " + result.id + " removed, (file not exists) !");
                    });
                    return;
                }

                //check time limit
                if (result.limit_time >= result.create_time) {
                    res.status(404).send();
                    remove_share("(" + result.id + ")", function (result2) {
                        if (result2)
                            console.log("share " + result.id + " removed (count limit reached) !");
                    });
                    return;
                }

                //check count download
                get_download_count_by_id(result.id, function (result2) {
                    if (result2) {
                        if (result.limit_download === -1)
                            return;
                        if (result2.count >= result.limit_download) {
                            res.status(404).send();
                            remove_share("(" + result.id + ")", function (result3) {
                                if (result3)
                                    console.log("share " + result.id + " removed (date limit reached) !");
                            });
                            return;
                        }
                    }
                });

                if (res._headerSent)
                    return;

                var split = result.file.split("/");
                var name = split[split.length - 1];
                var passwordOK = false;
                if (result.password === password) {
                    passwordOK = true;
                }

                if (res._headerSent)
                    return;

                if (direct === true && passwordOK) {
                    add_download_history(result, ip, function () {
                        //specify Content will be an attachment
                        console.log('<' + ip + '> Starting download: ' + result.file);
                        var stream = fs.createReadStream(result.file, {bufferSize: 64 * 1024});
                        var stats = fs.statSync(result.file);
                        res.setHeader('Content-disposition', 'attachment; filename=' + name);
                        res.setHeader('Content-Length', stats.size);

                        stream.pipe(res);

                        stream.on('end', () => {
                            console.log('<' + ip + '> Finish download: ' + result.file);
                            res.end();
                        });

                        req.on('close', () => {
                            console.log('<' + ip + '> Closed download: ' + result.file);
                            stream.close();
                            res.end();
                        });

                        //check count download
                        get_download_count_by_id(result.id, function (result2) {
                            if (result2) {
                                if (result.limit_download === -1)
                                    return;
                                if (result2.count >= result.limit_download) {
                                    console.log("stop sending " + result.id + " !");
                                    remove_share("(" + result.id + ")", function (result3) {
                                        if (result3)
                                            console.log("share " + result.id + " removed !");
                                    });
                                    return;
                                }
                            }
                        });
                    });
                } else {
                    var error = !passwordOK ? "Wrong password !" : false;
                    res.render(path.join(__dirname + '/public/download'), {name: name, size: result.size, error: error, password: !passwordOK});
                }
            }
        });
    }
});

// view the file by it's token (token)
app.get('/view/:token', function (req, res) {
    var token = req.params.token;
    var direct = req.query.direct || true;
    var password = req.query.password || null;
    var file = req.query.path || false;
    token = xss(token);

    if (file) { // in this case, an admin is downloading a file
        check_auth(req, res, function (connected) {
            if (connected) {
                viewFile(file, req, res);
            }
        });
    } else { // in this case, the user is not an admin, the token is used
        get_share_by_token(token, function (result) {
            if (!result)
                res.status(404).send();
            else {

                file = result.file;
                //check if file exists
                if (!fs.existsSync(file)) {
                    res.status(404).send();
                    remove_share("(" + result.id + ")", function (result2) {
                        if (result2)
                            console.log("share " + result.id + " removed, (file not exists) !");
                    });
                    return;
                }

                //check time limit
                if (result.limit_time >= result.create_time) {
                    res.status(404).send();
                    remove_share("(" + result.id + ")", function (result2) {
                        if (result2)
                            console.log("share " + result.id + " removed (count limit reached) !");
                    });
                    return;
                }

                if (res._headerSent)
                    return;

                var split = file.split("/");
                var name = split[split.length - 1];
                var passwordOK = false;
                if (result.password === password) {
                    passwordOK = true;
                }

                if (res._headerSent)
                    return;

                if (direct === true && passwordOK) {
                    viewFile(file, req, res);
                } else {
                    var error = !passwordOK ? "Wrong password !" : false;
                    res.render(path.join(__dirname + '/public/view/text'), {name: name, size: result.size, error: error, password: !passwordOK});
                }
            }
        });
    }
});

app.get('/stream', function (req, res) {
    var path = req.query.path || "";
    var stat = fs.statSync(path);
    var fileSize = stat.size;
    var range = req.headers.range;

    if (range) {
        var parts = range.replace(/bytes=/, "").split("-");
        var start = parseInt(parts[0], 10);
        var end = parts[1]
                ? parseInt(parts[1], 10)
                : fileSize - 1;
        var chunksize = (end - start) + 1;

        var file = fs.createReadStream(path, {start: start, end: end});
        var head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4'
        };
        res.writeHead(206, head);
        file.pipe(res);

    } else {
        console.log("stream entire content");
        const head = {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4'
        };
        res.writeHead(200, head);
        fs.createReadStream(path).pipe(res);
    }
});

app.get('/transcode', function (req, res) {
    var file = req.query.file || "";
    if (file) {
        var split = file.split("/");
        var name = split[split.length - 1];
        var ext = name.split('.').pop();
        var output = transcoderDir + "/" + name + ".mp4";

        var progressBar = new ProgressEmitter();
        progressBars.set(output, [{type: "transcode", input: file, output: output}, progressBar]);

        transcode(file, output, progressBar, function (err) {
            progressBars.delete(file);
            if (err) {
                console.log("Failed transcode of : " + file);
            }
        });
        res.send(JSON.stringify({message: "transcoding started"}));
    }
});

// (API) create the link and return the link
app.put('/share', function (req, res) {
    check_auth(req, res, function (result) {
        if (result) {
            var id = Number(req.body.id) || 0;
            var file = req.body.file || "";
            var size = req.body.size || 0;
            var time = req.body.time || null;
            var count = req.body.count || -1;
            var token = req.body.token || "";
            var password = req.body.password || null;

            if (file === null || file === "") {
                res.send(JSON.stringify({error: "Missing file !"}));
                return;
            }

            if (token === null || token === "") {
                res.send(JSON.stringify({error: "Missing token !"}));
                return;
            }

            token = xss(token);
            token = token.replace(/\s/g, ''); //remove spaces
            password = xss(password);

            if (password === "")
                password = null;

            // protect token collision
            get_share_by_token(token, function (result) {
                console.log(typeof id + " / " + typeof result.id);
                if (result && result.id != id) { // token exists and id are differents
                    res.send(JSON.stringify({error: "Bad id <-> token association !"}));
                    console.log("Bad id <-> token association !!!!");
                    return;
                } else if (result && id === 0) { // token exists and it's a new share
                    res.send(JSON.stringify({error: "Token already exist !"}));
                    console.log("Token already exist !");
                    return;
                } else { // token not exists or it's an update
                    if (result.id === id) { // update
                        update_share(id, file, token, time, count, password, function (result) {
                            if (result)
                                res.send(JSON.stringify({file: file, token: token}));
                            else
                                res.send(JSON.stringify({error: "An error occured !"}));
                        });
                    } else { // insert
                        add_share(file, size, token, time, count, password, function (result) {
                            if (result)
                                res.send(JSON.stringify({file: file, token: token, showUrl: true}));
                            else
                                res.send(JSON.stringify({error: "An error occured !"}));
                        });
                    }
                }
            });
        } else
            res.status(403).send();
    });
});
// (API) list active links, with stats
app.get('/listshares', function (req, res) {
    check_auth(req, res, function (result) {
        if (result) {
            var limit = req.query.limit || 10;
            var offset = req.query.offset || 0;
            var order = req.query.order || 'asc';
            var sort = req.query.sort || 'id';
            var search = req.query.search || '';
            get_all_shares(limit, offset, order.toUpperCase(), sort, search, function (results) {
                var rows = [];
                var total = 100;
                if (results) {
                    rows = results[0];
                    total = results[1][0].total;
                }
                res.send(JSON.stringify({rows: rows, total: total}));
            });
        } else
            res.status(403).send();
    });
});
// (API) list files in a path
app.post('/listfiles', function (req, res) {
    check_auth(req, res, function (result) {
        if (result) {
            var reqpath = req.body.path || PATH;
            if (reqpath === "/")
                reqpath = PATH;
            if (!reqpath.startsWith(PATH))
                reqpath = PATH;
            fs.readdir(reqpath, (err, result) => {
                var files = [];
                result.forEach(file => {
                    var fileSync = fs.statSync(reqpath + "/" + file);
                    var fileObj = {
                        name: file,
                        path: reqpath + "/" + file,
                        folder: fileSync.isDirectory(),
                        size: humanFileSize(fileSync.size, false),
                        date: humanTimeDate(fileSync.mtime.getTime(), 'YYYY-MM-DD HH:mm')};
                    files.push(fileObj);
                });
                res.send(JSON.stringify({path: reqpath, files: files}));
            });
        } else
            res.status(403).send();
    });
});
// (API) compress folder
app.post('/compress', function (req, res) {
    check_auth(req, res, function (result) {
        if (result) {
            var input = req.body.input || null;
            var output = req.body.output || null;
            if (!progressBars.has(output)) {
                console.log("Starting compression of : " + output);
                var progressBar = new ProgressEmitter();
                progressBars.set(output, [{type: "compress", input: input, output: output}, progressBar]);
                compress(input, output, progressBar, function (err) {
                    progressBars.delete(output);
                    if (err) {
                        console.log("Failed compression of : " + output);
                        res.send(JSON.stringify({error: err}));
                    } else {
                        console.log("Successfull compression of : " + output);
//                        var dir = path.dirname(output).split(path.sep).pop();
                        var dir = path.dirname(output);
                        res.send(JSON.stringify({input: input, output: output, path: dir}));
                    }
                });
//                progressBar.on('progress', function (progress) {
//                    console.log('Compression progress : ' + progress.percentage + '% (eta : ' + progress.eta + ')');
//                });
            } else {
                var progressBar = progressBars.get(output)[1];
                res.send(JSON.stringify({progress: progressBar.getLast()}));
            }
        } else
            res.status(403).send();
    });
});
// (API) remove file or folder
app.post('/delete', function (req, res) {
    check_auth(req, res, function (result) {
        if (result) {
            var file = req.body.file || null;
            fs.remove(file, function (err) {
                if (err)
                    res.send(JSON.stringify({error: err}));
                else {
//                    var dir = path.dirname(file).split(path.sep).pop();
                    var dir = path.dirname(file);
                    res.send(JSON.stringify({path: dir}));
                }
            });
        } else
            res.status(403).send();
    });
});
// (API) upload file
app.post('/upload', function (req, res, next) {
    check_auth(req, res, function (result) {
        if (result && uploadDir !== null) {
//            fileUpload.fileHandler(function () {});
            res.send(JSON.stringify({data: uploadDir}));
        } else
            res.status(403).send();
    });
});
// (API) upload file
app.post('/download', function (req, res, next) {
    check_auth(req, res, function (result) {
        if (result && downloadDir !== null) {
            var url = req.body.url || null;
            var file = req.body.file || null;
            file = downloadDir + "/" + file;

            console.log(url);
            if (!progressBars.has(file)) {
                var progressBar = new ProgressEmitter();
                progressBars.set(file, [{type: "download", input: url, output: file}, progressBar]);

                download(url, file, progressBar, function (err) {
                    progressBars.delete(file);
                    if (err) {
                        console.log("Failed download of : " + file);
                        res.send(JSON.stringify({error: err}));
                    } else {
                        console.log("Successfull download of : " + file);
                        var dir = path.dirname(file);
                        res.send(JSON.stringify({data: downloadDir}));
                    }
                });

//                progressBar.on('progress', function (progress) {
////                    console.log('Job progress : ' + JSON.stringify(progress));
//                    console.log('Download progress : ' + progress.percentage + '% (eta : ' + progress.eta + ')');
//                });
            } else {
                var progressBar = progressBars.get(file)[1];
//                console.log('Job progress : ' + JSON.stringify(progressBar));
                res.send(JSON.stringify({progress: progressBar.getLast()}));
            }
        } else
            res.status(403).send();
    });
});
// (API) disable an active link
app.delete('/dellinks', function (req, res) {
    check_auth(req, res, function (result) {
        if (result) {
            var ids = req.body.ids || [];
            if (ids.length === 0)
                res.status(200).send();
            else
                remove_share("(" + ids.join(", ") + ")", function (result) {
                    if (result)
                        res.status(200).send();
                });
        } else
            res.status(403).send();
    });
});
// (API) list stats by date
app.get('/stats', function (req, res) {
    check_auth(req, res, function (result) {
        if (result) {
            get_all_download_history(function (results) {
                res.send(JSON.stringify({data: results}));
            });
        } else
            res.status(403).send();
    });
});
// (API) list active jobs
app.get('/listjobs', function (req, res) {
    check_auth(req, res, function (result) {
        if (result) {
            var rows = [];
            var total = 0;
            if (progressBars.size > 0) {
                var i = 0;
                for (var value of progressBars.values()) {
                    if (value[1]) {
                        rows[i] = {};
                        rows[i].type = value[0].type;
                        rows[i].in = value[0].input;
                        rows[i].out = value[0].output;
                        if (value[1] && value[1].getLast()) {
                            rows[i].percentage = value[1].getLast().percentage;
                            rows[i].eta = value[1].getLast().eta;
                        }
                    }
                    i++;
                }
                total = progressBars.size;
            }
            res.send(JSON.stringify({rows: rows, total: total}));
        } else
            res.status(403).send();
    });
});

var check_auth = function (req, res, result) {
    var user = auth(req);
    if (!user || !AUTH[user.name] || AUTH[user.name].password !== user.pass) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Basic realm="example"');
        res.end('Access denied');
        var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        console.log("access denied for " + ip + " user=" + (!user ? "undefined" : user.name));
        return result(false);
    } else {
        return result(user);
    }
};

var get_all_shares = function (limit, offset, sort, order, search, result) {
    if (search !== '') {
        pool.query([
            [
                'SELECT',
                'shares.*,',
                'COUNT(download_history.id) AS total_downloads',
                'FROM shares',

                'LEFT JOIN download_history ON shares.id = download_history.id_share',

                'WHERE shares.`file` LIKE \'%' + search + '%\' OR shares.token LIKE \'%' + search + '%\'',
                'WHERE shares.active = 1',

                'GROUP BY shares.id',
                'ORDER BY ' + order + ' ' + sort + ' LIMIT ' + offset + ', ' + limit
            ].join(' '),
            'SELECT COUNT(*) as total FROM shares WHERE file LIKE \'%' + search + '%\' OR token LIKE \'%' + search + '%\' WHERE shares.active = 1'].join(';'), function (error, results, fields) {
            if (error) {
                console.log(error);
                return result(false);
            }
            return result(results);
        });
    } else {
        pool.query([
            [
                'SELECT',
                'shares.*,',
                'COUNT(download_history.id) AS total_downloads',
                'FROM shares',

                'LEFT JOIN download_history ON shares.id = download_history.id_share',
                'WHERE shares.active = 1',

                'GROUP BY shares.id',
                'ORDER BY ' + order + ' ' + sort + ' LIMIT ' + offset + ', ' + limit
            ].join(' '),
            'SELECT COUNT(*) as total FROM shares WHERE shares.active = 1'].join(';'), function (error, results, fields) {
            if (error) {
                console.log(error);
                return result(false);
            }
            return result(results);
        });
    }
};

var get_share_by_id = function (id, result) {
    pool.query('SELECT * FROM shares WHERE `id` = ? LIMIT 0, 1', [id], function (error, results, fields) {
        if (error) {
            console.log(error);
        }
        if (results.length === 1)
            return result(results[0]);
        return result(false);
    });
};

var get_share_by_file = function (file, result) {
    pool.query('SELECT * FROM shares WHERE `file` = ?', [file], function (error, results, fields) {
        if (error) {
            console.log(error);
        }
        return result(results);
    });
};

var get_share_by_token = function (token, result) {
    pool.query('SELECT * FROM shares WHERE `token` = ? AND `active` = 1 LIMIT 0, 1', [token], function (error, results, fields) {
        if (error) {
            console.log(error);
        }
        if (results.length === 1)
            return result(results[0]);
        return result(false);
    });
};

var add_share = function (file, size, token, time, count, password, result) {
    pool.query('INSERT INTO shares SET ?', {file: file, size: size, token: token, limit_time: time, limit_download: count, password: password}, function (error, results, fields) {
        if (error) {
            console.log(error);
            return result(false);
        }
        return result(true);
    });
};

var update_share = function (id, file, token, time, count, password, result) {
    pool.query('UPDATE shares SET file = ?, token = ?, limit_time = ?, limit_download = ?, password = ? WHERE id = ?', [file, token, time, count, password, id], function (error, results, fields) {
        if (error) {
            console.log(error);
            return result(false);
        }
        return result(true);
    });
};

var add_download_history = function (file, address, result) {
    pool.query('INSERT INTO download_history SET ?', {file: file.file, id_share: file.id, address: address}, function (error, results, fields) {
        if (error) {
            console.log(error);
            return result(false);
        }
        return result(true);
    });
};

var get_all_download_history = function (result) {
    pool.query('SELECT COUNT(*) AS `y`, DATE_FORMAT(download_history.`date`,"%Y-%m-%d") AS `x` FROM download_history GROUP BY `x`', function (error, results, fields) {
        if (error) {
            console.log(error);
            return result(false);
        }
        return result(results);
    });
};

var get_download_count_by_id = function (id, result) {
    pool.query('SELECT COUNT(id_share) AS `count` FROM download_history WHERE id_share = ?', [id], function (error, results, fields) {
        if (error) {
            console.log(error);
            return result(false);
        }
        return result(results[0]);
    });
};

var remove_share = function (ids, result) {
    pool.query('UPDATE shares SET active = 0 WHERE id IN ' + ids, function (error, results, fields) {
        if (error) {
            console.log(error);
            return result(false);
        }
        return result(true);
    });
};

function viewFile(file, req, res) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    if (file) {
        var split = file.split("/");
        var name = split[split.length - 1];
        var ext = name.split('.').pop();
        var size = 0;
        var error = "";
        var stats = fs.statSync(file);
        res.setHeader('Content-disposition', 'filename=' + name);
        res.setHeader('Content-Length', stats.size);

        console.log('<' + ip + '> Starting view file: ' + file);

        switch (ext) {
            case "":
            case "txt":
            case "md":
            case "gcode":
            case "sh":
            case "json":
            case "sql":
            case "yml":
            case "html":
            case "js":
            case "css":
            case "css":
            case "css":
            case "css":
                fs.readFile(file, 'utf8', function (error, content) {
                    if (error)
                        content = error;
                    else
                        size = bytesToSize(fs.statSync(file).size);
                    res.render(path.join(__dirname + '/public/view/text'), {name: name, size: size, content: content, error: error});
                });
                break;
            case "jpg":
            case "png":
            case "gif":
                fs.readFile(file, function (error, data) {
                    if (error)
                        content = error;
                    else {
                        size = bytesToSize(fs.statSync(file).size);
                        var content = "data:image/" + ext + ";base64, " + new Buffer(data).toString('base64');
                    }
                    res.render(path.join(__dirname + '/public/view/img'), {name: name, size: size, content: content, error: error});
                });
                break;
            case "svg":
                fs.readFile(file, function (error, data) {
                    if (error)
                        content = error;
                    else {
                        size = bytesToSize(fs.statSync(file).size);
                        var content = "data:image/svg+xml;base64, " + new Buffer(data).toString('base64');
                    }
                    res.render(path.join(__dirname + '/public/view/img'), {name: name, size: size, content: content, error: error});
                });
                break;
            case "mp4":
            case "mkv":
            case "avi":
            case "mp3":
            case "aac":
            case "ac3": //see https://docs.espressif.com/projects/esp-adf/en/latest/design-guide/audio-samples.html
            case "webm":
                ffmpeg.ffprobe(file, function (err, metadata) {
                    var audioCodec = null;
                    var videoCodec = null;
                    metadata.streams.forEach(function (stream) {
                        if (stream.codec_type === "video")
                            videoCodec = stream.codec_name;
                        else if (stream.codec_type === "audio")
                            audioCodec = stream.codec_name;
                    });
                    var meta = {audio: audioCodec, video: videoCodec};
//                    console.log("Video codec: %s Audio codec: %s", videoCodec, audioCodec);
                    size = bytesToSize(fs.statSync(file).size);
                    res.render(path.join(__dirname + '/public/view/video'), {name: name, size: size, file: file, meta: meta, error: error});
                });
                break;
            case "pdf":
                fs.readFile(file, function (err, data) {
                    res.contentType("application/pdf");
                    res.send(data);
                });
                break;
            default:
                error = "Could not read this file !";
                res.render(path.join(__dirname + '/public/view/text'), {name: name, size: size, content: error, error: error});
        }
    } else {
        var error = "File not found !";
        res.render(path.join(__dirname + '/public/view/text'), {name: name, size: 0, content: error, error: error});
    }
}

function humanFileSize(bytes, si) {
    var thresh = si ? 1000 : 1024;
    if (Math.abs(bytes) < thresh) {
        return bytes + ' B';
    }
    var units = si
            ? ['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
            : ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
    var u = -1;
    do {
        bytes /= thresh;
        ++u;
    } while (Math.abs(bytes) >= thresh && u < units.length - 1);
    return bytes.toFixed(1) + ' ' + units[u];
}

function humanTimeDate(timestamp, format) {
    var date = moment(timestamp);
    if (date)
        return date.format(format);
    else
        return '-';
}

/**
 * You can use a nodejs module to do this, this function is really straightforward and will fail on error
 * Note that when computing a directory size you may want to skip some errors (like ENOENT)
 * That said, this is for demonstration purpose and may not suit a production environnment
 */
function directorySize(path, cb, size) {
    if (size === undefined) {
        size = 0;
    }

    fs.stat(path, function (err, stat) {
        if (err) {
            cb(err);
            return;
        }

        size += stat.size;

        if (!stat.isDirectory()) {
            cb(null, size);
            return;
        }

        fs.readdir(path, function (err, paths) {
            if (err) {
                cb(err);
                return;
            }

            async.map(paths.map(function (p) {
                return path + '/' + p;
            }), directorySize, function (err, sizes) {
                size += sizes.reduce(function (a, b) {
                    return a + b;
                }, 0);
                cb(err, size);
            });
        });
    });
}

/**
 * https://stackoverflow.com/questions/15900485/correct-way-to-convert-size-in-bytes-to-kb-mb-gb-in-javascript#18650828
 */
function bytesToSize(bytes) {
    var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0)
        return '0 Byte';
    var i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
    return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
}

var compress = function (input, outputFile, progressBar, callback) {
    var output = fs.createWriteStream(outputFile);
    var archive = archiver('zip');
    directorySize(input, function (err, totalSize) {

        var str = Progress({
            length: totalSize,
            time: 500 /* ms */
        });

        var prettyTotalSize = bytesToSize(totalSize);

        str.on('progress', function (progress) {
            progressBar.emit('progress', progress);
        });

        archive.on('end', function () {
            console.log('%s / %s (%d %)', prettyTotalSize, prettyTotalSize, 100);

            var archiveSize = archive.pointer();

            console.log('Archiver wrote %s bytes', bytesToSize(archiveSize));
            console.log('Compression ratio: %d:1', Math.round(totalSize / archiveSize));
            console.log('Space savings: %d %', (1 - (archiveSize / totalSize)) * 100);
            callback();
        });

        archive.pipe(str).pipe(output);

        archive.directory(input);

        archive.finalize(function (err, bytes) {
            if (err) {
                callback(err);
            }
        });
    });
};

var download = function (url, outputFile, progressBar, callback) {
    let download = wget.download(url, outputFile, {});
//    console.log(JSON.stringify(download, null, 1));
    var startTime = new Date().getTime();
    var size = 1;
    download.on('error', function (err) {
        if (err) {
            callback(err);
        }
    });
    download.on('start', function (fileSize) {
        size = fileSize;
        console.log("Start downloading " + fileSize + " bytes, " + url);
    });
    download.on('end', function (output) {
        console.log("Downloaded " + output);
        callback();
    });
    download.on('progress', function (progress) {
        typeof progress === 'number';
        var elapsedTime = new Date().getTime() - startTime;
        var transfered = size * progress;
        var remaining = size - transfered;
        var eta = elapsedTime * 100 / progress;
        progressBar.emit('progress', {percentage: progress * 100, transferred: transfered, length: size, remaining: remaining, eta: eta, runtime: elapsedTime});
    });
};

var transcode = function (input, output, progressBar, callback) {
    var stream = fs.createWriteStream(output, {mode: 0o755});
    var startTime = new Date().getTime();

    new ffmpeg(input)
            .withVideoCodec('libx264')
            .videoBitrate(1024)
            .withFps(24)
            .withAudioCodec('aac')
            .audioBitrate('96k')
            .audioFrequency(22050)
            .audioChannels(2)
            .toFormat('mp4')
            .outputOptions(['-frag_duration 100', '-movflags frag_keyframe+faststart', '-threads 1'])
            .on('progress', function (progress) {
                console.log('progress ' + progress.percent + '%');
//                console.log('progress ' + JSON.stringify(progress));
                var elapsedTime = new Date().getTime() - startTime;
                var size = progress.targetSize * 100 / progress.percent;
                var remaining = size - progress.targetSize;
                var eta = elapsedTime * 100 / progress.percent;
                progressBar.emit('progress', {percentage: progress.percent, transferred: progress.targetSize, length: size, remaining: remaining, eta: eta, runtime: elapsedTime});
            })
            .on('end', function () {
                console.log('file has been converted succesfully');
            })
            .on('error', function (err, stdout, stderr) {
                //console.log('an error happened: ' + err.message + stdout + stderr);
//                console.log('an error happened: ' + err.message);
                callback(err.message);
            })
            .pipe(stream, {end: true});
    console.log("transcoding started")
    callback();
};

var deleteFolderRecursive = function (path) {
    if (fs.existsSync(path)) {
        fs.readdirSync(path).forEach(function (file, index) {
            var curPath = path + "/" + file;
            if (fs.lstatSync(curPath).isDirectory()) { // recurse
                deleteFolderRecursive(curPath);
            } else { // delete file
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(path);
    }
};

//https://stackoverflow.com/questions/44740423/create-json-string-from-js-map-and-string
function mapToObj(map) {
    const obj = {};
    for (let [k, v] of map)
        obj[k] = v;
    return obj;
}

app.listen(PORT, HOST, function () {
    console.log(`Running on http://${HOST}:${PORT}`);
});

process.on('SIGINT', function () {
    process.exit(0);
});