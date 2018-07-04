'use strict';

//init app
const config = require('config');
const mysql = require('mysql');
const xss = require("xss");
const express = require('express');
const helmet = require('helmet');
const fileUpload = require('jquery-file-upload-middleware');
const path = require('path');
const auth = require('basic-auth');
const fs = require('fs-extra');
const moment = require('moment');
const async = require('async');
const archiver = require('archiver');

// Constants TODO config env
const PORT = config.get('Config.Server.port');
const HOST = config.get('Config.Server.host');
const PATH = config.get('Config.Paths.root_share');
const AUTH = config.get('Config.Users');

var app = express();

// enable POST request decoding
var bodyParser = require('body-parser');
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

        //close limited downloads, shedule
        pool.query('SELECT COUNT(*) AS `count` FROM shares', function (err, rows, fields) {
            if (err)
                throw err;
            console.log(rows[0].count + " registered shares !");
        });
    });
//    //create the history if not exist
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
    token = xss(token);
    get_share_by_token(token, function (result) {
        if (!result)
            res.status(404).send();
        else {
            //check time limit
            if (result.limit_time >= result.create_time) {
                res.status(404).send();
                remove_share("(" + result.id + ")", function (result2) {
//                    if (result2)
//                        console.log("share " + result.id + " removed !");
                });
                return;
            }
            //check count download
            get_download_count_by_id(result.id, function (result2) {
                if (result2) {
                    console.log(result2.count + ' / ' + result.limit_download);
                    if (result2.count >= result.limit_download) {
                        res.status(404).send();
                        remove_share("(" + result.id + ")", function (result3) {
//                            if (result3)
//                                console.log("share " + result.id + " removed !");
                        });
                        return;
                    }
                }
            });

            if (res._headerSent)
                return;

            //TODO check count
            fs.readFile(result.file, function (err, content) {
                if (err) {
                    res.status(404).send();
                    console.log(err);
                    return;
                } else {
                    var split = result.file.split("/");
                    var name = split[split.length - 1];
                    var passwordOK = false;
                    if (result.password === password) {
                        passwordOK = true;
                    }

                    if (res._headerSent)
                        return;

                    if (direct === true && passwordOK) {
                        var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
                        add_download_history(result, ip, function () {
                            //specify Content will be an attachment
                            res.setHeader('Content-disposition', 'attachment; filename=' + name);
                            res.end(content);

                            //check count download
                            get_download_count_by_id(result.id, function (result2) {
                                if (result2) {
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
                        var fileSync = fs.statSync(result.file);
                        var error = !passwordOK ? "Wrong password !" : false;
                        res.render(path.join(__dirname + '/public/download'), {name: name, size: humanFileSize(fileSync.size, false), error: error, password: !passwordOK});
                    }
                }

            });
        }
    });
});

// (API) create the link and return the link
app.put('/share', function (req, res) {
    check_auth(req, res, function (result) {
        if (result) {
            var id = req.body.id || 0;
            var file = req.body.file || "";
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
                if (!result) {
                    res.send(JSON.stringify({error: "Token already exist !"}));
                    return;
                }
            });

            if (id !== 0) {
                get_share_by_id(id, function (exists) {
                    if (exists) {
                        update_share(id, file, token, time, count, password, function (result) {
                            if (result)
                                res.send(JSON.stringify({file: file, token: token}));
                            else
                                res.send(JSON.stringify({error: "An error occured !"}));
                        });
                    } else {
                        add_share(file, token, time, count, password, function (result) {
                            if (result)
                                res.send(JSON.stringify({file: file, token: token, showUrl: true}));
                            else
                                res.send(JSON.stringify({error: "An error occured !"}));
                        });
                    }
                });
            } else {
                add_share(file, token, time, count, password, function (result) {
                    if (result)
                        res.send(JSON.stringify({file: file, token: token, showUrl: true}));
                    else
                        res.send(JSON.stringify({error: "An error occured !"}));
                });
            }
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
            console.log("Starting compression of : " + output);
            compress(input, output, function (err) {
                if (err) {
                    console.log("Failed compression of : " + output);
                    res.send(JSON.stringify({error: err}));
                } else {
                    console.log("Successfull compression of : " + output);
                    var dir = path.dirname(output).split(path.sep).pop();
                    res.send(JSON.stringify({input: input, output: output, path: dir}));
                }
            });
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
                    var dir = path.dirname(file).split(path.sep).pop();
                    res.send(JSON.stringify({path: dir}));
                }
            });
        } else
            res.status(403).send();
    });
});
// (API) remove file or folder
app.post('/upload', function (req, res, next) {
    check_auth(req, res, function (result) {
        if (result && uploadDir !== null) {
            fileUpload.fileHandler({})(req, res, next);
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

var check_auth = function (req, res, result) {
    var user = auth(req);
    if (!user || !AUTH[user.name] || AUTH[user.name].password !== user.pass) {
        res.statusCode = 401;
        res.setHeader('WWW-Authenticate', 'Basic realm="example"');
        res.end('Access denied');
        var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        console.log("access denied for " + ip + " user=" + user.name);
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

var add_share = function (file, token, time, count, password, result) {
    pool.query('INSERT INTO shares SET ?', {file: file, token: token, limit_time: time, limit_download: count, password: password}, function (error, results, fields) {
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
    pool.query('INSERT INTO download_history SET ?', {id_share: file.id, address: address}, function (error, results, fields) {
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

var compress = function (input, outputFile, callback) {
    var output = fs.createWriteStream(outputFile);
    var archive = archiver('zip');
    directorySize(input, function (err, totalSize) {
        var prettyTotalSize = bytesToSize(totalSize);

//        output.on('close', function () {
//            callback();
//        });

        archive.on('progress', function (progress) {
            var percent = 100 - ((totalSize - progress.fs.processedBytes) / totalSize) * 100;
            console.log('%s / %s (%d %)', bytesToSize(progress.fs.processedBytes), prettyTotalSize, percent);
        });

        archive.on('end', function () {
            console.log('%s / %s (%d %)', prettyTotalSize, prettyTotalSize, 100);

            var archiveSize = archive.pointer();

            console.log('Archiver wrote %s bytes', bytesToSize(archiveSize));
            console.log('Compression ratio: %d:1', Math.round(totalSize / archiveSize));
            console.log('Space savings: %d %', (1 - (archiveSize / totalSize)) * 100);
            callback();
        });

        archive.pipe(output);


//        archive.bulk([
//            {cwd: input, src: ['**/*'], expand: true}
//        ]);
        archive.directory(input);

        archive.finalize(function (err, bytes) {
            if (err) {
                callback(err);
            }
        });
    });

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

app.listen(PORT, HOST, function () {
    console.log(`Running on http://${HOST}:${PORT}`);
});

process.on('SIGINT', function () {
    app.close(function (err) {
        process.exit(err ? 1 : 0);
    });
});