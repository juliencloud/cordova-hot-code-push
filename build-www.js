module.exports = function (grunt) {

    var path = require('path');
    var fs = require('fs');
    var sparkmd5 = require('spark-md5');

    function runBuild(mode, env) {
        var modules = [
            {
                name: 'app/js/libs/famous'
            },
            {
                name: 'app/js/libs/libs',
                exclude: ['app/js/libs/famous']
            },
            {
                name: 'main',
                exclude: ['app/js/libs/libs', 'app/js/libs/famous']
            }
        ];

        grunt.config('requirejs.' + mode + '.options.modules', modules);

        grunt.task.registerTask('delete-tmp', function() {
            grunt.file.delete('./tmp/');
        });
        grunt.task.registerTask('delete-www', function() {
            grunt.file.delete('./www/');
        });
        grunt.task.registerTask('copy-modules', function() {
            for (var i = 0; i < modules.length; i++) {
                grunt.file.copy('./tmp/' + modules[i].name + '.js', './www/' + modules[i].name + '.js');
            }
        });

        grunt.task.registerTask('copy-config', function () {
            grunt.file.copy('./src/config/mobile-' + env + '.js', './www/config.js');
            grunt.file.copy('./src/config/version.js', './www/version.js');
        });

        grunt.task.registerTask('manifest', function() {
            var done = this.async();
            var json = {
                "files": {},
                "load": [
                    'main.css',
                    'console.js',
                    'version.js',
                    'config.js',
                    'require.js',
                    'main.js'
                ],
                "root": '',
                "version": grunt.file.read("www/version.js").match(/APP_HYBRID_VERSION = \'([0-9]+\.[0-9]+\.[0-9]+)\'\;/)[1]
            };
            grunt.file.expand({cwd: 'www'}, '**/*.*').filter(function (item) {
                return ['index.html', 'bootstrap.js'].indexOf(item) === -1;
            }).forEach(function (item) {
                var filename = encodeURI(item);
                var key = filename;
                json.files[key] = {
                    hash: sparkmd5.ArrayBuffer.hash(grunt.file.read(path.join('www', item), {encoding: null})),
                    size: fs.statSync(path.join('www', item)).size
                };
            });
            grunt.file.write('www/manifest.json', JSON.stringify(json, null, 2));
            done();
        });
        grunt.task.run([
            'delete-tmp',
            'delete-www',
            'requirejs:' + mode,
            'copy-modules',
            'copy-config',
            'copy:resources',
            'delete-tmp',
            'sass:main',
            'requirejs:css',
            'manifest',
            'size_report:res',
            'size_report:js-css'
        ]);
    }

    grunt.registerTask('build-www-candidate-dev', 'Build without minification & obfuscation, config on dev', function () {
        runBuild('candidate', 'dev');
    });

    grunt.registerTask('build-www-candidate-stag', 'Build without minification & obfuscation, config on stag', function () {
        runBuild('candidate', 'stag');
    });

    grunt.registerTask('build-www-candidate-prod', 'Build without minification & obfuscation, config on prod', function () {
        runBuild('candidate', 'prod');
    });

    grunt.registerTask('build-www-release-dev', 'Build with minification & obfuscation, config on dev', function () {
        runBuild('release', 'dev');
    });

    grunt.registerTask('build-www-release-stag', 'Build with minification & obfuscation, config on stag', function () {
        runBuild('release', 'stag');
    });

    grunt.registerTask('build-www-release-prod', 'Final minified build, config on prod', function () {
        runBuild('release', 'prod');
    });

    grunt.config.merge({
        sass: {
            options: {
                style: 'compact',
                sourcemap: 'none'
            },
            'main': {
                files: {
                    './src/main.css': './src/main.sass'
                }
            }
        },
        requirejs: {
            options: {
                baseUrl: './src',
                mainConfigFile: './src/main.js',
                skipDirOptimize: true,
                generateSourceMaps: false,
                useStrict: false,
                preserveLicenseComments: false,
                allowSourceOverwrites: false,
                findNestedDependencies: true
            },
            'candidate': {
                options: {
                    dir: './tmp',
                    optimize: 'none'
                }
            },
            'release': {
                options: {
                    dir: './tmp',
                    optimize: 'uglify2',
                    uglify2: {
                        output: {
                            beautify: false
                        },
                        compress: {
                            sequences: true,
                            properties: true,
                            dead_code: true,
                            drop_debugger: true,
                            conditionals: true,
                            comparisons: true,
                            evaluate: true,
                            booleans: true,
                            loops: true,
                            unused: false, // needed to keep the functions names for the console
                            hoist_funs: true,
                            if_return: true,
                            join_vars: true,
                            cascade: true,
                            drop_console: false // needed to be used with console.js
                        },
                        warnings: false,
                        mangle: true
                    }
                }
            },
            'css': {
                options: {
                    cssIn: './src/main.css',
                    out: './www/main.css',
                    optimizeCss: 'standard', //.keepLines',
                    preserveLicenseComments: false
                }
            }
        },
        copy: {
            options: {
                noProcess: ['**/*'],
                timestamp: true,
                mode: true,
                encoding: null
            },
            'resources': {
                files: [{
                    expand: true,
                    filter: 'isFile',
                    cwd: 'src/',
                    src: [
                        'app/js/libs/recorder/recorderWorker.js',
                        'app/res/**/*',
                        'reveals/defs/*/res/**/*',
                        'reveals/common/res/**/*',
                        'index.html',
                        'console.js',
                        'require.js',
                        'bootstrap.js',
                        '!**/*.sketch'
                    ],
                    dest: './www/'
                }]
            }
        },
        size_report: {
            'res': {
                files: {
                    list: ['www/**/*.*', '!www/**/*.js', '!www/**/*.css'],
                    filer: 'isFile'
                }
            },
            'js-css': {
                files: {
                    list: ['www/**/*.js', 'www/**/*.css']
                }
            }
        }
    });
};
