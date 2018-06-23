'use strict';

// Constants TODO config env or file
const PORT = 80;
const HOST = '0.0.0.0';
const BASE_URL = "http://127.0.0.1";
const USERNAME = "";
const PASSWORD = "";
const PATH = "/share";

const AUTH = {'username': {password: 'password'}};
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const auth = require('basic-auth');
const fs = require('fs');

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

var mysql = require('mysql');
var pool = mysql.createPool({
    connectionLimit: 10,
    host: 'mysql',
    user: 'root',
    password: 'root',
    database: 'eazyshare'
});

pool.getConnection(function (err, connection) {
    if (err)
        throw err;
    console.log("Connected to MYSQL server !");
    //create the table if not exist
    pool.query(['CREATE TABLE IF NOT EXISTS shares',
        '( `id` int(11) NOT NULL AUTO_INCREMENT,',
        '`file` text NOT NULL,',
        '`token` varchar(40) NOT NULL,',
        '`creator` int(11) DEFAULT NULL,',
        '`create_time` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,',
        '`limit_time` timestamp NULL DEFAULT NULL,',
        '`limit_download` int(11) DEFAULT NULL,',
        'PRIMARY KEY (`id`,`token`))',
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

// download the file by it's token (i)
app.get('/download/:token', function (req, res) {
    var token = req.params.token;
    var direct = req.query.direct || true;
    get_share_by_token(token, function (result) {
        if (!result)
            res.status(404).send();
        else {
            fs.readFile(result.file, function (err, content) {
                if (err) {
                    res.status(404).send();
                    console.log(err);
                } else {
                    var split = result.file.split("/");
                    var name = split[split.length - 1];
                    if (direct === true) {
                        var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
                        add_download_history(result.file, ip, function () {
                            //specify Content will be an attachment
                            res.setHeader('Content-disposition', 'attachment; filename=' + name);
                            res.end(content);
                        });
                    } else {
                        //TODO add file name, size.
                        var fileSync = fs.statSync(result.file);
                        res.render(path.join(__dirname + '/public/download'), {name: name, size: humanFileSize(fileSync.size, false)});
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
            var file = req.body.file || null;
            var time = req.body.time || null;
            var count = req.body.count || -1;
            var token = req.body.token || null;
            //TODO check if the token already exist
            get_share_by_file(file, function (exists) {
                if (!exists) {
                    add_share(file, token, function (result) {
                        if (result)
                            res.send(JSON.stringify({file: file, url: BASE_URL + "/download/" + token}));
                    });
                } else {
                    res.send(JSON.stringify({error: "File already have a link !"}));
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
            var limit = req.params.limit;
            var offset = req.params.offset;
            var order = req.params.order;
            var sort = req.params.sort;
            var search = req.params.search;
            get_all_shares(limit, offset, order, sort, search, function (results) {
                var rows = [];
                var total = 10;
                if (results) {
                    rows = results;
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
                        date: fileSync.mtime.getTime()};
                    files.push(fileObj);
                });
                res.send(JSON.stringify({path: reqpath, files: files}));
            });
        } else
            res.status(403).send();
    });
});
// (API) disable an active link
app.delete('/dellinks', function (req, res) {
    check_auth(req, res, function (result) {
        if (result) {
            var ids = req.body.ids || [];
            remove_share("(" + ids.join(", ") + ")", function (result) {
                if (result)
                    res.status(200).send();
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
        return result(false);
    } else {
        return result(true);
    }
};

var get_all_shares = function (limit, offset, sort, order, search, result) {
    pool.query('SELECT * FROM shares', function (error, results, fields) {
        if (error) {
            console.log(error);
        }
        return result(results);
    });
};

var get_share_by_file = function (file, result) {
    pool.query('SELECT * FROM shares WHERE `file` = ? LIMIT 0, 1', [file], function (error, results, fields) {
        if (error) {
            console.log(error);
        }
        if (results.length === 1)
            return result(results[0]);
        return result(false);
    });
};

var get_share_by_token = function (token, result) {
    pool.query('SELECT * FROM shares WHERE `token` = ? LIMIT 0, 1', [token], function (error, results, fields) {
        if (error) {
            console.log(error);
        }
        if (results.length === 1)
            return result(results[0]);
        return result(false);
    });
};

var add_share = function (file, token, result) {
    pool.query('INSERT INTO shares SET ?', {file: file, token: token}, function (error, results, fields) {
        if (error) {
            console.log(error);
            return result(false);
        }
        return result(true);
    });
};

var add_download_history = function (file, address, result) {
    pool.query('INSERT INTO download_history SET ?', {file: file, address: address}, function (error, results, fields) {
        if (error) {
            console.log(error);
            return result(false);
        }
        return result(true);
    });
};

var remove_share = function (ids, result) {
    pool.query('DELETE FROM shares WHERE id IN ' + ids, function (error, results, fields) {
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
    var date = new Date(timestamp * 1000);
    if (date)
        return date.format(format);
    else
        return '-';
}

app.listen(PORT, HOST, function() {
    console.log(`Running on http://${HOST}:${PORT}`);
});