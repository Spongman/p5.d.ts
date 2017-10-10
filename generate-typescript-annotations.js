/// @ts-check

const createEmitter = require('./emit');
//const yuidocs = require('./data.json');
const request = require('request');
const fs = require('fs');

var emit;
var yuidocs;
var _rootDir;
var _outputDir;

var constants = {};

// http://stackoverflow.com/a/2008353/2422398
var JS_SYMBOL_RE = /^[$A-Z_][0-9A-Z_$]*$/i;

var P5_CLASS_RE = /^p5\.([^.]+)$/;

var P5_ALIASES = [
	'p5',
	// These are supposedly "classes" in our docs, but they don't exist
	// as objects, and their methods are all defined on p5.
	'p5.dom',
	'p5.sound'
];

var EXTERNAL_TYPES = [
	'HTMLCanvasElement',
	'Float32Array',
	'AudioParam',
	'AudioNode',
	'GainNode',
	'DelayNode',
	'ConvolverNode',
	'Event'
];

var YUIDOC_TO_TYPESCRIPT_PARAM_MAP = {
	// TODO: Not sure if there's a better type for generic Objects...
	'Object': 'any',
	'Any': 'any',
	'Number': 'number',
	'Integer': 'number',
	'String': 'string',
	'Constant': 'any',
	//'Color': 'number',
	'undefined': 'undefined',
	'Null': 'null',
	'Array': 'any[]',
	'Boolean': 'boolean',
	'*': 'any',
	'Void': 'void',
	'P5': 'p5',
	// TODO: Not sure if there's a better type for functions. TypeScript's
	// spec seems to mention something called "wildcard function types"
	// here: https://github.com/Microsoft/TypeScript/issues/3970
	'Function': '() => any',
};

function getClassitems(className) {
	return yuidocs.classitems.filter(function (classitem) {
		// Note that we check for classitem.name because some methods
		// don't appear to define them... Filed this as
		// https://github.com/processing/p5.js/issues/1252.
		return classitem.class === className && classitem.name;
	});
}

function isValidP5ClassName(className) {
	return P5_CLASS_RE.test(className) && className in yuidocs.classes ||
		P5_CLASS_RE.test("p5." + className) && ("p5." + className) in yuidocs.classes;
}

function validateMethod(classitem, overload) {
	var errors = [];
	var paramNames = {};
	var optionalParamFound = false;

	if (!classitem.is_constructor && !JS_SYMBOL_RE.test(classitem.name)) {
		errors.push('"' + classitem.name + '" is not a valid JS symbol name');
	}

	(overload.params || []).forEach(function (param) {
		if (param.optional) {
			optionalParamFound = true;
		} else if (optionalParamFound) {
			errors.push('required param "' + param.name + '" follows an ' +
				'optional param');
		}

		if (param.name in paramNames) {
			errors.push('param "' + param.name + '" is defined multiple times');
		}
		paramNames[param.name] = true;

		/*
		if (param.name === 'class') {
			errors.push('param "' + param.name + '" is a reserved word in JS');
		}
		*/

		if (!JS_SYMBOL_RE.test(param.name)) {
			errors.push('param "' + param.name +
				'" is not a valid JS symbol name');
		}

		if (!translateType(param.type)) {
			errors.push('param "' + param.name + '" has invalid type: ' +
				param.type);
		}

		if (param.type === 'Constant') {

			var myRe = /either\s+(?:[A-Z0-9_]+\s*,?\s*(?:or)?\s*)+/g;
			var myArray = myRe.exec(param.description);
			if (classitem.name === 'endShape' && param.name === 'mode')
				myArray = ['CLOSE'];
			if (myArray) {
				var match = myArray[0];

				var values = [];

				var reConst = /[A-Z0-9_]+/g;
				var matchConst;
				while ((matchConst = reConst.exec(myArray[0])) !== null) {
					values.push(matchConst);
				}
				var paramWords = param.name.split('.').pop().replace(/([A-Z])/g, ' $1').trim().toLowerCase().split(' ');
				var propWords = classitem.name.split('.').pop().replace(/([A-Z])/g, ' $1').trim().toLowerCase().split(' ');

				var constName;
				if (paramWords.length > 1 || propWords[0] === "create") {
					constName = paramWords.join('_');
				} else if (propWords[propWords.length - 1] === paramWords[paramWords.length - 1]) {
					constName = propWords.join('_');
				} else {
					constName = (propWords[0] + '_' + paramWords[paramWords.length - 1]);
				}

				constName = constName.toUpperCase();
				constants[constName] = values;

				param.type = constName;
			}
		}
	});

	if (overload.return && !translateType(overload.return.type)) {
		errors.push('return has invalid type: ' + overload.return.type);
	}

	return errors;
}


var missingTypes = {};

/**
 * 
 * @param {string} type 
 * @param {string} [defaultType] 
 */
function translateType(type, defaultType) {
	if (type === void 0)
		return defaultType;

	if (type === "")
		return "";

	if (type.length > 2 && type.substring(type.length - 2) === "[]")
		return translateType(type.substr(0, type.length - 2), defaultType) + "[]";

	type = type.trim();

	var matchFunction = type.match(/Function\(([^)]*)\)/i);
	if (matchFunction) {
		var paramTypes = matchFunction[1].split(',');
		return "(" + paramTypes.map((t, i) => "p" + (i + 1) + ":" + translateType(t, "any")).join(",") + ") => any";
	}

	if (type.charAt(0) === "{")
		debugger;

	var parts = type.split('|');
	if (parts.length > 1)
		return parts.map(t => translateType(t, defaultType)).join('|');

	if (type in YUIDOC_TO_TYPESCRIPT_PARAM_MAP)
		return YUIDOC_TO_TYPESCRIPT_PARAM_MAP[type];

	if (EXTERNAL_TYPES.indexOf(type) >= 0)
		return type;

	if (isValidP5ClassName(type))
		return type;

	if (constants[type])
		return type;

	missingTypes[type] = emit.getCurrentSourceFile();;
	return defaultType;
}

function translateParam(param) {
	var name = param.name;
	if (name === 'class')
		name = 'theClass';
	return name + (param.optional ? '?' : '') + ': ' + translateType(param.type, "any");
}

function generateClassMethod(className, classitem) {
	if (classitem.overloads)
		classitem.overloads.forEach(function (overload) { generateClassMethodWithParams(className, classitem, overload) });
	else
		generateClassMethodWithParams(className, classitem, classitem);
}


function generateClassMethodWithParams(className, classitem, overload) {
	var errors = validateMethod(classitem, overload);
	var params = (overload.params || []).map(translateParam);
	var returnType = overload.chainable ? className
		: overload.return ? translateType(overload.return.type, "any")
			: 'void';
	var decl;

	if (classitem.is_constructor) {
		decl = 'constructor(' + params.join(', ') + ')';
	} else {
		decl = (overload.static ? 'static ' : '') + classitem.name + '(' +
			params.join(', ') + '): ' + returnType;
	}

	if (emit.getIndentLevel() === 0) {
		decl = 'declare function ' + decl + ';';
	}

	if (errors.length) {
		emit.sectionBreak();
		emit('// TODO: Fix ' + classitem.name + '() errors in ' +
			classitem.file + ', line ' + overload.line + ':');
		emit('//');
		errors.forEach(function (error) {
			console.error(_rootDir + "/" + classitem.file + ":" + overload.line + ", " + error);
			emit('//   ' + error);
		});
		emit('//');
		emit('// ' + decl);
		emit('');
	} else {
		emit.description(classitem.description);
		emit(decl);
	}
}

function generateClassConstructor(className) {
	var classitem = yuidocs.classes[className];

	if (!classitem.is_constructor)
		throw new Error(className + " is not a constructor");

	generateClassMethod(className, classitem);
}

function generateClassProperty(className, classitem) {
	var decl;

	if (JS_SYMBOL_RE.test(classitem.name)) {
		// TODO: It seems our properties don't carry any type information,
		// which is unfortunate. YUIDocs supports the @type tag on properties,
		// and even encourages using it, but we don't seem to use it.
		var translatedType = translateType(classitem.type, "any");
		var defaultValue = classitem.default;
		if (classitem.final && translatedType === "string" && !defaultValue) {
			defaultValue = classitem.name.toLowerCase().replace(/_/g, '-');
		}

		var decl;
		if (defaultValue) {
			decl = classitem.name + ": ";
			if (translatedType === "string")
				decl += "'" + defaultValue.replace(/'/g, "\\'") + "'";
			else
				decl += defaultValue;
		} else {
			decl = classitem.name + ': ' + translatedType;
		}


		emit.description(classitem.description);

		if (emit.getIndentLevel() === 0) {
			emit('declare ' + (classitem.final ? 'const ' : 'var ') + decl + ';');
		} else {
			if (classitem.final)
				return;
			emit(decl);
		}

	} else {
		emit.sectionBreak();
		emit('// TODO: Property "' + classitem.name +
			'", defined in ' + classitem.file +
			', is not a valid JS symbol name');
		emit.sectionBreak();
	}
}

function generateClassProperties(className) {
	getClassitems(className).forEach(function (classitem) {
		//classitem.file = classitem.file.replace(/\\/g, '/');
		emit.setCurrentSourceFile(classitem.file);
		if (classitem.itemtype === 'method') {
			generateClassMethod(className, classitem);
		} else if (classitem.itemtype === 'property') {
			generateClassProperty(className, classitem);
		} else {
			emit('// TODO: Annotate ' + classitem.itemtype + ' "' +
				classitem.name + '"');
		}
	});
}

function generateP5Properties(className) {
	emit.sectionBreak();
	emit('// Properties from ' + className);
	emit.sectionBreak();

	generateClassProperties(className);
}

function generateP5Subclass(className) {
	var info = yuidocs.classes[className];
	var nestedClassName = className.match(P5_CLASS_RE)[1];

	var file = info.file;//.replace(/\\/g, '/');
	emit.setCurrentSourceFile(file);

	emit('class ' + nestedClassName +
		(info.extends ? ' extends ' + info.extends : '') + ' {');
	emit.indent();

	generateClassConstructor(className);
	generateClassProperties(className);

	emit.dedent();
	emit('}');
}

function generate(outputDir) {
	var p5Aliases = [];
	var p5Subclasses = [];

	Object.keys(yuidocs.classes).forEach(function (className) {
		if (P5_ALIASES.indexOf(className) !== -1) {
			p5Aliases.push(className);
		} else if (P5_CLASS_RE.test(className)) {
			p5Subclasses.push(className);
		} else {
			throw new Error(className + " is documented as a class but " +
				"I'm not sure how to generate a type definition " +
				"for it");
		}
	});

	emit = createEmitter(outputDir + '/p5.d.ts');

	emit('declare class p5 {');
	emit.indent();

	p5Aliases.forEach(generateP5Properties);

	emit.dedent();
	emit('}\n');

	emit('declare namespace p5 {');
	emit.indent();

	p5Subclasses.forEach(generateP5Subclass);

	emit.dedent();
	emit('}\n');

	emit.close();

	emit = createEmitter(outputDir + '/p5.global-mode.d.ts');

	emit('///<reference path="p5.d.ts" />\n');

	p5Aliases.forEach(generateP5Properties);

	emit('// Constants ');
	Object.keys(constants).forEach(function (key) {
		var values = constants[key];

		/*
		emit('// ' + key);
		values.forEach(function (v) {
			emit('declare const ' + v + ': string;');
		});
		*/

		emit('type ' + key + ' =');
		values.forEach(function (v, i) {
			var str = ' typeof ' + v;
			str = (i ? '|' : ' ') + str;
			if (i === values.length - 1)
				str += ';'
			emit('    ' + str);
		});

		emit('');

	});

	emit.close();
}

function doit(jsonPath, rootDir, outputDir) {

	_rootDir = rootDir.replace(/[\/\\]*$/, '');
	_outputDir = outputDir;

	fs.readFile(jsonPath, "utf8", (err, data) => {

		yuidocs = JSON.parse(data);
		generate(outputDir);

		for (var t in missingTypes) {
			console.error(_rootDir + "/" + missingTypes[t] + ": missing type: ", t);
		}
	});
}

module.exports = generate;

if (!module.parent) {

	var args = Array.prototype.slice.call(process.argv, 2);
	doit.apply(null, args);

}
