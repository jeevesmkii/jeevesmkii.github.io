/* 
* - Bangertron 9000 by JeevesMII (2022) -
* https://jeevesmkii.github.io/bangertron/
*
* Bangertron 9000 is a shared playlist audio player running in a browser that fetches audio from youtube.
* I am deeply indebted to JWZ's youtubedown perl script for the youtube reverse engineering that I've
* more or less copied wholesale to make this work. This almost certainly constitutes a derivative work
* of that script, so I've included its license and copyright statement below.
*
* Please note: I wrote this for one specific small community. If you like the way this works and you're
* thinking of copying the idea or the code, PLEASE DON'T. Obviously I can't stop you, but there's a
* tragedy of the commons type scenario I see happening here. I enjoy the fact that Youtube doesn't really
* have proper DRM and you can relatively easily download videos. The fastest way to screw that up for
* everyone is for the Record Industry Assholes Association to see someone turn Youtube in to an ad-free
* music player, which is more or less what Bangertron 9000 is. So this is for me and a few hundred other
* select individuals to enjoy. Lets keep it that way, eh? Thank you.
*
*/

/*
* - youtubedown.pl - 
* https://www.jwz.org/hacks/youtubedown
*
* Copyright � 2007-2022 Jamie Zawinski <jwz@jwz.org>
*
* Permission to use, copy, modify, distribute, and sell this software and its
* documentation for any purpose is hereby granted without fee, provided that
* the above copyright notice appear in all copies and that both that
* copyright notice and this permission notice appear in supporting
* documentation.  No representations are made about the suitability of this
* software for any purpose.  It is provided "as is" without express or
* implied warranty.
*
*/

const __BT_VERSION = "0.4.1";
const __BT_WS_HOST = "bangertron.8bpsmodem.com";
const __BT_WS_PORT = 5555;

var _bt_known_ciphers = {};
var _bt_media = {};

var _bt_await = 
	{
	ciphers : {},
	media : {}
	};

const __BT_SUBSYSTEM =
	{
	UNKNOWN : 0,
	PLAYER : 1,
	WEBSOCKET : 2,
	};

const __BT_PLAYER_STATE =
	{
	PAUSED  : 1,
	PLAYING : 2,
	IDLE    : 3,
	FATAL_ERROR : 4
	};
	
const __BT_MEDIA_EVENT =
	{
	ERROR : 1,
	READY : 2,
	PLAY  : 3,
	PAUSE : 4,
	ENDED : 5,
	ABORT : 6
	};
	
const __BT_UI_ELEMENT =
	{
	PAUSE_PLAY : 1,
	VOLUME     : 2
	};
	
const __BT_UI_EVENT = 
	{
	MOUSEIN   : 1,
	MOUSEOUT  : 2,
	CLICK     : 3,
	MOUSEDOWN : 4,
	MOUSEUP   : 5,
	MOUSEMOVE : 6
	};
	
const __BT_HOVER_STATE =
	{
	NONE  : 1,
	HOVER : 2
	};
	
const __BT_BUTTON_STATE =
	{
	DOWN : 1,
	UP   : 2
	// MORE_ENERGY : 3
	};

const __BT_WS_MODE =
	{
	MASTER : 1,
	SLAVE  : 2,
	FREE   : 3,
	MOD    : 4,
	NOCONN : 5,
	CONNECTING : 6
	};
	
const __BT_WS_EVENT =
	{
	OPEN    : 1,
	CLOSE   : 2,
	MESSAGE : 3,
	ERROR   : 4
	};

const __BT_WS_COMMAND =
	{
	MODE : {cmd : "mode", handler : bt_ws_handle_mode, unsolicited : true },
	PLAYLIST : {cmd : "playlist", handler : bt_ws_handle_playlist, unsolicited : false },
	TRACK : {cmd :"track", handler : bt_ws_handle_track, unsolicited : true},
	LOG : {cmd: "log", handler : bt_ws_handle_log, unsolicited : true },
	CHALLENGE : {cmd: "challenge", handler : bt_ws_handle_challenge, unsolicited : false }
	};

var _bt_player =
	{
	state : __BT_PLAYER_STATE.PAUSED,
	audio : {},
	idle_time : 0,
	errors : 0,
	
	dj_show : false,
	
	media : 
		{
		current_track : undefined,
		next_track : undefined
		},
	
	flavour_txt : 
		{
		active : false,
		repeat : 0,
		current : undefined,
		queue  : []
		},
	
	ws :
		{
		socket : undefined,
		mode : __BT_WS_MODE.NOCONN,
		current : undefined,
		queue : [],
		
		last_connect : 0,
		backoff : 0,
		auth_client_random : undefined,
		auth_pass : undefined
		}
	};

// I listened to Waka Waka by Shakira so many times while writing this. Kill me.
var _bt_debug =
	{
	debug_show : false,
	use_local : false,
	
	local_rsc :
		{
		html : "shakira-html2.html",
		js : "ythtml5.js",
		audio : "http://localhost/shakira.m4a"
		}
	};

const __BT_FLAVOUR_TEXT = 
	{
	idle : "Bangertron 9000 online! Press play to begin the bangers :catJam:",
	connecting : ":Hackermans: Attempting to connect to the banger server. Please stand by. :Hackermans:",
	fatal_error : ":Pepega: A fatal error occured! :Pepega: try reloading I guess?",
	not_youtube : ":Pepega: Bangertron 9000 must be run in a Youtube tab to work. Go to youtube.com and click the Bangertron bookmarklet again. :Pepega:"
	}; 

function bt_new_error(ss, txt)
	{
	return {"subsystem" : ss, "text" : txt};
	}

function bt_debug_log(msg)
	{
	var debug_box = document.getElementById("debugbox");
	debug_box.value += "<" + new Date().toISOString() + "> " + msg + "\n";
	}

function bt_curry(func)
	{
	return function curried(...args)
		{
		if (args.length >= func.length)
			return func.apply(this, args);
		else
			return function(...args2) 
				{
				return curried.apply(this, args.concat(args2));
				}
		};
	}

function bt_handle_error(err)
	{
	var subsystem = __BT_SUBSYSTEM.UNKNOWN;
	if ("subsystem" in err)
		subsystem = err.subsystem;
	var txt = "unknown";
	if ("text" in err)
		txt = err.text;
	
	bt_debug_log("Error: \"" + txt + "\"");
	
	// generally speaking, error handling strategy is:
	// - for player errors, reset the player and request the next (or replacement) track to try next
	// - for websocket errors, reconnect the websocket and try again.
	// - unknown errors should only come from programming faults, try our best to recover by resetting the world.
	// TODO: we should probably distinguish "blocked in your country" as a distinct class of error, someone very unlucky may encounter a string of them.
	
	if (++_bt_player.errors > 3)
		{
		// try to set he flavour text to fatal error and then just give up.
		_bt_player.state = __BT_PLAYER_STATE.FATAL_ERROR;
		bt_ws_close();
		bt_set_flavour_text("fatal_error", -1);
		bt_debug_log("A fatal error occured. Stopping.");
		return;
		}
		
	switch (subsystem)
		{
	case __BT_SUBSYSTEM.PLAYER:
		// clean all our caches.
		_bt_known_ciphers = {};
		_bt_media = {};
		_bt_await.ciphers = {},
		_bt_await.media = {};
		
		// TODO: different action for slave/mod mode
		bt_ws_request_next_track();
		break;
		
	case __BT_SUBSYSTEM.WEBSOCKET:
		// reset the awaits
		_bt_await.ciphers = {},
		_bt_await.media = {};
		
		// closing the websocket will trigger a reconnect if the fatal error flag isn't raised
		bt_ws_close();
		break;
		
	default:
		// Yikes. This really shouldn't happen. Lets try our best to recover. Absolutely no guarantee any of this stuff will work in this case.
		// TODO: should we do something with the audio element? pause it? set idle mode?
		_bt_known_ciphers = {};
		_bt_media = {};
		_bt_await.ciphers = {},
		_bt_await.media = {};
		bt_ws_close();
		break; 
		}
	}

function bt_url_decode(url)
	{
	url = url.replace(/[+]/g, " ");
	url = url.replace(/%([a-z0-9]{2})/ig, 
		function (hex_couplet)
			{
			return String.fromCharCode(parseInt(hex_couplet.substr(1), 16));
			});
	
	return url;
	}
	
function bt_base64_encode(arr)
	{
	let b64c = v =>
		{
		v &= 0x3f;
		return String.fromCharCode((v < 26) ? 65 + v :
			((v < 52) ? 71 + v :
			((v < 62) ? v - 4 :
			((v == 62) ? 43 : 47))));
		}; 
	
	var result = "";
	
	var i = 0;
	for (; i <= arr.length - 3; i += 3)
		{
		result +=
			b64c(arr[i] >> 2) +
			b64c(arr[i] << 4 | arr[i+1] >> 4) +
			b64c(arr[i+1] << 2 | arr[i+2] >> 6) +
			b64c(arr[i+2]);
		}
	
	var padding = arr.length % 3;
	if (padding)
		{
		result +=
			b64c(arr[i] >> 2) +
			(padding == 2 ? b64c(arr[i] << 4 | arr[i+1] >> 4) : b64c(arr[i] << 4)) +
			(padding == 2 ? b64c(arr[i+1] << 2) : "=") +
			"=";
		}
	
	return result;
	}
	
function bt_base64_decode(base64)
	{
	// sanity check: encoded data must be a multiple of 4 bytes
	if (base64.length % 4 != 0)
		return undefined;
		
	var len = base64.length * 3 / 4;
	if (base64.endsWith("=="))
		len -= 2;
	else if (base64.endsWith("="))
		len -= 1;
	
	var result = new Uint8Array(len);
	
	let b64d = c =>
		{
		c = c.charCodeAt(0);
		
		return (c >= 65 && c <= 90) ?  c - 65 :
			((c >= 97 && c <= 122) ? c - 71 :
			((c >= 48 && c <= 57) ? c + 4 :
			((c == 43) ? 62 :
			((c == 47) ? 63 : 0))));  
		};
	
	var i, o;
	i = o = 0;
	
	for (; i < base64.length - 4; i += 4)
		{
		var c1 = b64d(base64[i]);
		var c2 = b64d(base64[i+1]);
		var c3 = b64d(base64[i+2]);
		var c4 = b64d(base64[i+3]);
		
		result[o++] = ((c1 << 2) | (c2 >> 4)) & 0xff;
		result[o++] = ((c2 << 4) | (c3 >> 2)) & 0xff;
		result[o++] = ((c3 << 6) | c4) & 0xff;
		}
		
	var c1 = b64d(base64[i]);
	var c2 = b64d(base64[i+1]);
	var c3 = b64d(base64[i+2]);
	var c4 = b64d(base64[i+3]);
	
	result[o++] = ((c1 << 2) | (c2 >> 4)) & 0xff;
	if (base64[i+2] != "=")
		result[o++] = ((c2 << 4) | (c3 >> 2)) & 0xff;
	if (base64[i+3] != "=")
		result[o++] = ((c3 << 6) | c4) & 0xff;
	
	return result;
	}
	
function bt_str_to_char_array(str)
	{
	// we're truncating all characters to 8 bits, so multibyte chars will be wrong here.
	// this isn't a problem for our purposes, but I guess... be aware?
	
	var result = new Uint8Array(str.length);
	for (var i = 0; i < str.length; i++)
		result[i] = str.charCodeAt(i) & 0xff;
		
	return result;
	}
	
function bt_char_array_concat(arr1, arr2)
	{
	var result = new Uint8Array(arr1.length + arr2.length);
	result.set(arr1);
	result.set(arr2, arr1.length);
	return result;
	}
	
function bt_compile_regexp(pattern, subs, modifiers)
	{
	// Javascript, may god and all his little angels curse it's rotten name, has no /x modifier in
	// it's regexp nor can you write variables in to patterns. This is a massive problem when it comes to
	// the big complex regex youtubedown uses.
	//
	// This function strips all whitepace from a pattern string and subsitutes varables of the form $foo
	// for strings specified by an associative array subs which is of the form {var => value, ...},
	// then returns a compiled regexp.
	
	if (subs)
		{
		pattern = pattern.replace(/\$[a-z][a-z0-9_]*/isg, 
			function(match)
				{
				var key = match.substr(1);
				if (key in subs)
					return subs[key];
				else
					return match;
				});
		}
		
	pattern = pattern.replace(/\s/g, "");
	return new RegExp(pattern, modifiers);
	}
	
function bt_regexp_escape(str)
	{
	// Javascript regexp has no \Q and \E, so.....
	return str.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
	}

function bt_get_cipher_base(html)
	{
	html = html.replace(/\\/gs, "");
	
	// I've ignored the line that matches player javascript files that do not end in "base", I think that's
	// now obsolete.
	var cipher_base = html.match(/\/jsbin\/((?:html5)?player[-_][^<>"']+?\/base)\.js/s);
	if(!cipher_base)
		cipher_base = html.match(/\/player\/([^<>"']+\/player[-_][^<>"']+\/base)\.js/s);
	if (!cipher_base)
		throw bt_new_error(__BT_SUBSYSTEM.PLAYER, "bt_get_cipher_base: no cipher base found in yt html.");
	
	// in the youtubedown script, the global removal of backslashes is performed again on the output
	// but they shouldn't exist any more thanks to the first line of this function.
	// Maybe there's somethting I'm not understanding, but I've ignored it.
	return cipher_base[1];
	}

function bt_fetch_url(url, callback)
	{
	fetch(url, 
			{
			credentials: "same-origin",
			cache: "no-cache",
			mode: "same-origin"
			})
		.then(response =>
			{
			if (!response.ok)
				throw bt_new_error(__BT_SUBSYSTEM.PLAYER, "bt_fetch_url: http request failed.");
			else
				return response.text();
			})
		.then(text => callback(text))
		.catch(err => bt_handle_error(err));
	}
	
function bt_new_cipher(cipher_base, cipher_spec)
	{
	_bt_known_ciphers[cipher_base] = cipher_spec;
	if (cipher_base in _bt_await.ciphers)
		{
		callbacks = _bt_await.ciphers[cipher_base];
		_bt_await.ciphers[cipher_base] = new Array();
		
		callbacks.forEach(
			callback => callback());
		}
	}
	
function bt_find_cipher_spec(cipher_base, player_js)
	{
	// When I first had this idea, I had the naive notion that I could just find the
	// function name that did the signature munging, eval the javascript and then call
	// that function. Hah! No. It's buried about a million layers deep in code and can't
	// really be called without invoking god knows what else. Guess we'll just do it the
	// way JWZ does.
	
	if (!player_js)
		{
		var uri = "https://www.youtube.com/s/player/" + cipher_base + ".js";
		if (_bt_debug.use_local)
			uri = _bt_debug.local_rsc.js;
		
		bt_debug_log("Fetching cipher spec " + cipher_base + ".");
		bt_fetch_url(uri, bt_curry(bt_find_cipher_spec)(cipher_base));
		return;
		}
	
	var subs =
		{
		v1 : "[\\$a-zA-Z][a-zA-Z\\d]*(?:\\.[\\$a-zA-Z][a-zA-Z\\d]*)?",
		v2 : "[\\$a-zA-Z][a-zA-Z\\d]?(?:\.[\\$a-zA-Z][a-zA-Z\\d]?)?"
		};

	// Method 1. C from var A = B.sig || C (B.s)
	var fn_re = "$v1 = ( $v1 ) \\.sig \\|\\| ( $v1 ) \\( \\1 \\.s \\)";
	var fn = player_js.match(bt_compile_regexp(fn_re, subs, "s"));
	if (fn)
		fn = fn[1];
		
	// Method 2. C in A.set("signature", C(d));
	if (!fn)
		{
		fn_re = "$v1 \\. set \\s* \\( \"signature\", \\s*" +
			"( $v1 ) \\s* \\( \\s* $v1 \\s* \\)";
		fn = player_js.match(bt_compile_regexp(fn_re, subs, "s"));
		if (fn)
			fn = fn[1]; 
		}
	
	// Method 3. C in (A || (A = "signature"), B.set (A, C (d)))
	if (!fn)
		{
		fn_re = "\"signature\" \\s* \\) \\s* , \\s*" +
			"$v1 \\. set \\s* \\( \\s*" +
			"$v1 \\s* , \\s*" +
			"( $v1 ) \\s* \\( \\s* $v1 \\s* \\)";
			
		fn = player_js.match(bt_compile_regexp(fn_re, subs, "s"));
		if (fn)
			fn = fn[1];
		}
	
	
	// Method 4. B in A = B(C(A)), D(E,F(A)) where C is decodeUriComponent and F is encodeUriComponent
	if (!fn)
		{
		// convert calls of the form (0,F)	to just F
		player_js = player_js.replace(bt_compile_regexp("\\(0,($v1)\\)", subs, "gs"), "$1");
	
		fn_re = "( $v1 ) = ( $v1 ) \\( " +		// A = B (
					"$v1 \\( \\1 \\) \\) ," +	// C ( A )),
					"$v1 \\( $v1 , " +			// D ( E,
					"$v1 \\( $v1 \\) \\)"		// F ( A ))
					
		fn = player_js.match(bt_compile_regexp(fn_re, subs, "s"));
		if (fn)
			fn = fn[2];
		}
		
	// Method 5. C in  A.set (B.sp, D (C (E (B.s)))) where D is encodeUriComponent and E is decodeUriComponent
	if (!fn)
		{
		fn_re = "$v2 \\. set \\s* \\( \\s*" +			// A.set (
					"$v2 \\s* , \\s*" +					// B.sp,
					"$v1  \\s* \\( \\s*" +				// D (
					"( $v2 ) \\s* \\( \\s*" +			// C (
					"$v1  \\s* \\( \\s*" + 				// E (
					"$v2 \\s*" + 						// B.s
					"\\) \\s* \\) \\s* \\) \\s* \\)";	// ))))
					
		fn = player_js.match(bt_compile_regexp(fn_re, subs, "s"));
		if (fn)
			fn = fn[1];
		}
		
	// Method 6. C in A.set (B, C (d)) or A.set (B.sp, C (B.s))
	if (!fn)
		{
		fn_re = "$v2 \\. set \\s* \\( \\s*" +
					"$v2 \\s* , \\s*" +
					"( $v2 ) \\s* \\( \\s* $v2 \\s* \\) \\s* \\)";
		fn = player_js.match(bt_compile_regexp(fn_re, subs, "s"));
		if (fn)
			fn = fn[1];
		}
	
	// if none of that worked, oh dear.
	if (!fn)
		throw bt_new_error(__BT_SUBSYSTEM.PLAYER, "bt_get_cipher: failed to find cipher function name.");
	
	subs.fn = bt_regexp_escape(fn);
	
	var fn_body_re = "\\b function \\s+ $fn \\s* \\( $v1 \\) \\s* { ( .*? ) }";
	var fn_body = player_js.match(bt_compile_regexp(fn_body_re, subs, "s"));
	
	if (!fn_body)
		{
		fn_body_re = "(?: \\b var \\s+ | [,;] \\s* )" +
						"$fn \\s* = \\s* function \\s* \\( $v1 \\)" +
						"\\s* { ( .*? ) }";
		
		fn_body = player_js.match(bt_compile_regexp(fn_body_re, subs, "s"));
		} 
	
	if (fn_body)
		fn_body = fn_body[1];
	else
		throw bt_new_error(__BT_SUBSYSTEM.PLAYER, "bt_get_cipher: failed to find cipher function body.");
	
	// if the JS minimiser has inlined the swap function, turn that back in to a swap call.
	var swap_re = "var \\s ( $v1 ) = ( $v1 ) \\[ 0 \\];" +
					"\\2 \\[ 0 \\] = \\2 \\[ ( \\d+ ) % \\2 \\. length \\];" +
					"\\2 \\[ \\3 \\]= \\1 ;";
	fn_body = fn_body.replace(bt_compile_regexp(swap_re, subs, "s"), "$2=swap($2,$3);");
	
	
	var cipher_spec = new Array();
	var m, n;
	
	fn_body.split(/\s*;\s*/).forEach(
		stmt =>
			{
			// rewrite statements of the form a["b"] as a.b
			stmt = stmt.replace(bt_compile_regexp("^ ( $v1 ) \\[\" ( $v1 ) \"\\]", subs, "s"), "$1.$2");
			
			// ignore the opening split and the closing join statements
			if (stmt.match(bt_compile_regexp("^ ( $v1 ) = \\1 . $v1 \\(\"\"\\) $", subs, "s")) ||
				stmt.match(bt_compile_regexp("^ return \\s+ $v1 \\. $v1 \\(\"\"\\) $", subs, "s")))
				{
				return;
				}
			else if (stmt.match(bt_compile_regexp("^ ( $v1 ) = \\1 .  $v1 \\(\\)  $", subs, "s")))
				{
				// reverse call
				cipher_spec.push("r");
				}
			else if (m = stmt.match(bt_compile_regexp("^ ( $v1 ) = \\1 . $v1 \\( (\\d+) \\) $", subs, "s")))
				{
				// slice call
				cipher_spec.push("s" + match[2]);
				}
			else if ((m = stmt.match(bt_compile_regexp("^ ( $v1 ) = ( $v1 ) \\( \\1 , ( \\d+ ) \\) $", subs, "s"))) ||
					(n = stmt.match(bt_compile_regexp("^ (    )   ( $v1 ) \\( $v1 , ( \\d+ ) \\) $", subs, "s"))))
				{
				var s = m ? m[2] : n[2];
				var p = m ? m[3] : n[3];
				
				s = s.replace(/^.*\./sg, "");
				subs.f = bt_regexp_escape(s);
				
				// find the body of the called function
				var call_re = " \\b \"? $f \"? : \\s*" +
								"function \\s* \\( [^(){}]*? \\) \\s*" +
								"( \\{ [^{}]+ \\} )";
				var fn3 = player_js.match(bt_compile_regexp(call_re, subs, "s"));
				if (!fn3)
					throw bt_new_error(__BT_SUBSYSTEM.PLAYER, "bt_get_cipher: called function in cipher spec not found in player js.");
				
				fn3 = fn3[1];
				
				// find what the body does
				if (fn3.match(bt_compile_regexp("var \\s ( $v1 ) = ( $v1 ) \\[ 0 \\];", subs, "s")))
					{
					// swap type
					cipher_spec.push("w" + p);
					}
				else if (fn3.match(bt_compile_regexp("\\b $v1 \\. reverse\\(", subs, "s")))
					{
					// reverse
					cipher_spec.push("r");
					}
				else if (fn3.match(bt_compile_regexp("return \\s* $v1 \\. slice", subs, "s")) ||
						fn3.match(bt_compile_regexp(" \\b $v1 \\. splice ", subs, "s")))
					{
					// split/splice
					cipher_spec.push("s" + p);
					}
				else
					{
					throw bt_new_error(__BT_SUBSYSTEM.PLAYER, "bt_get_cipher: can't interpret called function in cipher spec.");
					}	
				}
			else
				{
				throw bt_new_error(__BT_SUBSYSTEM.PLAYER, "bt_get_cipher: unparseable statement in cipher function.");
				}
			
			});
				
	cipher_spec = cipher_spec.join(" ");
	bt_new_cipher(cipher_base, cipher_spec);
	}

function bt_apply_signature(url, sig, cipher_spec, sp)
	{
	if (!sp)
		sp = "signature";
		
	cipher_spec.split(/\s+/).forEach(
		op =>
			{
			var m;
			if (op == "r")
				sig = sig.split("").reverse().join("");
			else if(m = op.match(/^s(\d+)$/))
				sig = sig.substr(parseInt(m[1]));
			else if (m = op.match(/^w(\d+)$/))
				{
				var i = parseInt(m[1]);
				sig = sig[i] + sig.slice(1, i) + sig[0] + sig.slice(i+1);
				}
			
			});
			
	// remove sig tags from the URL if they already exist
	var sig_re = "& ( signature| sig | " +
		bt_regexp_escape(sp) + ") = [^&]+";
	url = url.replace(bt_compile_regexp(sig_re, undefined, "gs"), "");
	url += "&" + sp + "=" + sig;
	
	return url;
	}

function bt_get_cipher_spec(cipher)
	{
	var cipher_spec;
	if (cipher in _bt_known_ciphers)
		cipher_spec = _bt_known_ciphers[cipher];
	return cipher_spec;
	}

function bt_await_cipher_spec(cipher_base, callback)
	{
	if (cipher_base in _bt_await.ciphers)
		_bt_await.ciphers[cipher_base].push(callback);
	else
		_bt_await.ciphers[cipher_base] = new Array(callback);
	}

function bt_await_fmts(id, callback)
	{
	if (id in _bt_await.media)
		_bt_await.media[id].push(callback);
	else
		_bt_await.media[id] = new Array(callback);
	}
	
function bt_is_awaiting_fmts(id)
	{
	return (id in _bt_await.media && _bt_await.media[id].length > 0);
	}

function bt_prune_media(id)
	{
	var time = Date.now() / 1000;
	
	if (id in _bt_media)
		{
		_bt_media[id] = _bt_media[id].filter(
			fmt =>
				{
				return fmt.expires > time;
				});
		}	
	}

function bt_get_fmts(id)
	{
	bt_prune_media(id);
	
	var fmts;
	if (id in _bt_media)
		fmts = _bt_media[id];
	return fmts;
	}
	
function bt_handle_new_fmts()
	{
	// if the player is currently idle, try to trigger the next track
	if (_bt_player.state == __BT_PLAYER_STATE.IDLE)
		bt_audio_cue_next_track();
	}

function bt_postprocess_fmts(id, fmts)
	{
	var processed_fmts = new Array();
	
	for (var i = 0; i < fmts.length; i++)
		{
		var fmt = fmts[i];
		if ("sig" in fmt)
			{
			// this format's URL needs a signature param applied.
			var cipher_spec = bt_get_cipher_spec(fmt.cipher_base);
			if (!cipher_spec)
				{
				// we don't know this cipher yet, fetch it.
				bt_await_cipher_spec(fmt.cipher_base, function() { bt_postprocess_fmts(id, fmts) });
				bt_find_cipher_spec(fmt.cipher_base);
				return;
				}
				
			fmt.url = bt_apply_signature(fmt.url, fmt.sig, cipher_spec, fmt.sig_param);
			}
			
		processed_fmts.push(fmt);
		}
	
	bt_prune_media(id);
	if (!(id in _bt_media))
		_bt_media[id] = new Array();
	_bt_media[id] = _bt_media[id].concat(processed_fmts);
	
	if (id in _bt_await.media)
		{
		callbacks = _bt_await.media[id];
		_bt_await.media[id] = new Array();
		
		callbacks.forEach(
			callback => callback());
		}
	}

function bt_find_fmts(id, html)
	{
	if (!html)
		{
		var uri = "https://www.youtube.com/watch?v=" + id;
		if (_bt_debug.use_local)
			uri = _bt_debug.local_rsc.html;
			
		bt_debug_log("Fetching formats for " + id + ".");
		bt_fetch_url(uri, bt_curry(bt_find_fmts)(id));
		return;
		}
	
	var cfg = undefined;
	var cipher_base = bt_get_cipher_base(html);
	
	if (cfg = html.match(/ytplayer\.config\s*=\s*({.*?});/s))
		cfg = cfg[1];
	else
		throw bt_new_error(__BT_SUBSYSTEM.PLAYER, "get_fmts: no youtube player config structure.");
	
	
	// try to parse a JSON structure from cfg
	try
		{
		cfg = JSON.parse(cfg);
		
		if (!("args" in cfg) || !("player_response" in cfg.args))
			throw "get_fmts: missing expected JSON structure in player config.";
	
		
		cfg = JSON.parse(cfg.args.player_response);
		}
	catch (err)
		{
		cfg = undefined;
		}
	
	// if that didn't work, try getting config JSON from ytInitialPlayerResponse
	if (!cfg)
		{
		try
			{
			var init_resp = "";
			if (init_resp = html.match(/var\s+ytInitialPlayerResponse\s*=\s*({.*?});/s))
				{
				init_resp = init_resp[1];
				cfg = JSON.parse(init_resp);
				}
			}
		catch (err)
			{
			throw bt_new_error(__BT_SUBSYSTEM.PLAYER, "get_fmts: no youtube player config structure.");
			}
		}

	if (!("streamingData" in cfg))
		throw bt_new_error(__BT_SUBSYSTEM.PLAYER, "get_fmts: no streamingData in player config.");
	
	var title = "Unknown";
	if ("videoDetails" in cfg && "title" in cfg.videoDetails)
		title = cfg.videoDetails.title;
	
	if (!("expiresInSeconds" in cfg.streamingData))
		throw bt_new_error(__BT_SUBSYSTEM.PLAYER, "get_fmts: no expiry time in streaming data.");
	
	var expires = parseInt(cfg.streamingData.expiresInSeconds);
	// knock 10 minutes or 10% off the expiry time, whichever is the lesser, so we never
	// use an expired URL under any circumstance.
	expires = Math.round(Date.now() / 1000 + expires - (expires * 0.1 < 600 ? expires * 0.1 : 600));
	
	var loudness, pLoudness;
	loudness = pLoudness = "";
	
	if ("playerConfig" in cfg && "audioConfig" in cfg.playerConfig)
		{
		if ("loudnessDb" in cfg.playerConfig.audioConfig)
			loudness = cfg.playerConfig.audioConfig.loudnessDb;
		if ("perceptualLoudnessDb" in cfg.playerConfig.audioConfig)
			pLoudness = cfg.playerConfig.audioConfig.perceptualLoudnessDb;
		}
	
	// For the moment, push only audio formats to the list. If we find videos later that have no
	// audio only streams, we'll have to do a hidden video player to play those too.
	var fmts = new Array();
	if ("adaptiveFormats" in cfg.streamingData && Array.isArray(cfg.streamingData.adaptiveFormats))
		{
		cfg.streamingData.adaptiveFormats.forEach(
			adpt_fmt =>
				{
				if (adpt_fmt.mimeType.match(/^audio\//s))
					{
					var fmt = {};
					
					if ("signatureCipher" in adpt_fmt)
						{
						// URL that requires a signature.
						var params = adpt_fmt.signatureCipher;
					
						var url, sig, sig_param;
						if (!(url = params.match(/\burl=([^&]+)/)))
							return;
					
						if (!(sig = params.match(/\bs=([^&]+)/)))
							return;
					
						if (!(sig_param = params.match(/\bsp=([^&]+)/)))
							return;
					
						fmt.url = bt_url_decode(url[1]);
						fmt.sig = bt_url_decode(sig[1]);
						fmt.sig_param = sig_param[1];
						}
					else if ("url" in adpt_fmt)
						{
						// Plain URL that can be used as is.
						fmt.url = bt_url_decode(adpt_fmt.url);
						}
					else
						{
						// unparseable format
						return;
						}
						
					fmt.mime_type = adpt_fmt.mimeType;
					fmt.bitrate = adpt_fmt.bitrate;
					fmt.loudness = loudness;
					fmt.perceptual_loudness = pLoudness;
					fmt.cipher_base = cipher_base;
					fmt.expires = expires;
					fmt.title = title;
					fmts.push(fmt);
					}
				});
		}
	
	// error out if there are no usable formats
	if (fmts.length <= 0)
		throw bt_new_error(__BT_SUBSYSTEM.PLAYER, "get_fmts: no usable formats discovered.");
	
	bt_postprocess_fmts(id, fmts);
	}

function bt_strip_unbalanced_parens(str)
	{
	if (!str)
		return;
	
	new Array("()", "[]", "{}").forEach(
		paren =>
			{
			var strip_close_re = new RegExp("^([^\\" + paren[0] + "]*?)\\" + paren[1], "gs");
			var strip_open_re = new RegExp("\\" + paren[0] + "([^\\" + paren[1] + "]*)$", "gs");
			
			var scratch = str;
			do
				{
				str = scratch;
				scratch = str.replace(strip_close_re, "$1");
				}
			while (scratch.length < str.length);
			
			do
				{
				str = scratch;
				scratch = str.replace(strip_open_re, "$1");
				}
			while (scratch.length < str.length);
			});
	
	return str;
	}

function bt_parse_title(title)
	{
	// we only need to do this once if we're reusing format data
	if (typeof(title) == "object")
		return title;
	
	// This function is disturbingly impressive. 10 years of JWZ's distilled knowledge
	// of every way a song title can be formatted. One can admire it without ever wanting
	// to aqcuire the practical experience necessary to duplicate it.
	// I have never known this function to fail in its perl incarnation. 
	// Mistakes in translation are my own.
	
	// replace various 2 byte punctuation marks with their plain old ascii equivalents.
	// this also replaces/removes various things illegal in file names, but that doesn't really
	// concern us.
	title = title.replace(/[\u{2012}-\u{2013}]+/gsu, "-");
	title = title.replace(/[\u{2014}-\u{2015}]+/gsu, "--");
	title = title.replace(/\u{2018}+/gsu, "`");
	title = title.replace(/\u{2019}+/gsu, "'");
	title = title.replace(/[\u{201c}\u{201d}]+/gsu, "\"");
	title = title.replace(/`/gs, "'");
	title = title.replace(/\s*(\|\s*)+/gs, " - ");
	title = title.replace(/\\/gs, "");
	
	// various whitespace, abbreviation and formatting illegal in filenames cleanups
	title = title.replace(/^\s+|\s+$/gs, "");
	title = title.replace(/\s+/gs, " ");
	title = title.replace(/\s+,/gs, ",");
	title = title.replace(/\s+w\/\s+/, " with ");
	title = title.replace(/(\d)\/(?=\d)/gs, "$1.");
	title = title.replace(/\//gs, " - ");
	
	// prune various promotional shite
	var promo_re = "\\b ( ( (in \\s*)? " +
		"( HD | TV | HDTV | HQ | 720\\s*p? | 1080\\s*p? | 4K | High [-\\s]* Qual (ity)? ) |" +
		"FM(\\'s)? |" +
		"EP s?|" + // JWZ has an independent match group here to exclude matching EP when it means "episode", javascript doesn't support that and I don't care.
		"MV | performance |" +
		"SXSW ( \\s* Music )? ( \\s* \\d{4} )? |" +
		"Showcasing \\s Artist |" +
		"Presents |" +
		"(DVD|CD)? \\s+ (out \\s+ now | on \\s+ (iTunes|Amazon)) |" +
		"fan \\s* made |" +
		"( FULL|COMPLETE ) \\s+ ( set|concert|album ) |" +
		"FREE \\s+ ( download|D\\s*[[:punct:]-]\\s*L ) |" +
		"Live \\s+ @ \\s .*" +
		") \\b \\s* )+";
	title = title.replace(bt_compile_regexp(promo_re, undefined, "gsi"), "");
	
	// gumpf about the video
	var vid_re = "\\b (The\\s*)? (Un)?Off?ici[ae]le?" +
		"( [-\\s]* " +
		"	( Video | Clip | Studio | Music | Audio | Stereo | Lyric )s? " +
		")+\\b";
	title = title.replace(bt_compile_regexp(vid_re, undefined, "gsi"), "");
	
	title = title.replace(/\bMusic([-\s]*(Video|Clip)s?)+\b/gsi, "");
	title = title.replace(/\.(mp[34]|m4[auv]|mov|mqv|flv|wmv)\b/gsi, "");
	title = title.replace(/\b(on\s*)?[A-Za-z-0-9\.]+\.com$/gsi, "");
	title = title.replace(/\b(brought to you|made possible) by .*$/gsi, "");
	title = title.replace(/\bour interview with\b/gsi, " interviews ");
	title = title.replace(/\b(perform|performs|performing)\b/gsi, " - ");
	title = title.replace(/\b(play   |plays   |playing   )\b/gsi, " - ");
	title = title.replace(/\s+ [\|+]+  \s+                  /gsi, " - ");
	title = title.replace(/!+/gs, "!");
	title = title.replace(/\s+-+[\s-]*\s/gs, " - ");
	title = title.replace(/\s+/gs, " ");
	
	// JWZ uses the :punct: class which matches a lot more stuff than my replacement
	// Unfortunate, but there's really not a lot I can do about it.
	var subs = {
		empty_phrase : "\\s*(" +
			"the | new | free | amazing | (un)?off?ici[ae]le? |" +
			"on | iTunes | Amazon | [\\s\\.,\\/#\\!$%\\^&\\*;:=\\-_`~]+ | version |" +
			"cc | song | video | audio | band | source | field |" +
			"extended | mix | remix | edit | stream | uncut | single |" +
			"track | to be | released? | out | now |" +
			"teaser | trailer | videoclip" +
			")?\\s*",
		obrack : "[\\(\\[\\{]",
		cbrack : "[\\)\\]\\}]"
		};
		
	// remove parens with nothing meaningful in them
	var scratch = title;
	var parens_re = new Array(
		bt_compile_regexp("\\(($empty_phrase)*\\)", subs, "gsi"),
		bt_compile_regexp("\\[($empty_phrase)*\\]", subs, "gsi"),
		bt_compile_regexp("\\{($empty_phrase)*\\}", subs, "gsi")
		);
	
	parens_re.forEach(
		regexp =>
			{
			do
				{
				title = scratch;
				scratch = title.replace(regexp, "");
				}
			while (scratch.length < title.length);
			});
		
	title = scratch;
	
	// remove extraneous trailing chars and and some common instances of "by" that don't refer the song
	title = title.replace(/[-;:,\s]+$/gs, "");
	title = title.replace(/bDirected by\b/gsi, "Dir.");
	title = title.replace(/\bProduced by\b/gsi, "Prod.");
	
	var artist, track, junk, match;
	
	// TITLE (JUNK)
	var track_re = "^(.*)\\s+$obrack+ (.*) $cbrack+ $";
	if (match = title.match(bt_compile_regexp(track_re, subs, "si")))
		{
		title = match[1];
		junk = match[2];
		}
	
	// TITLE (Dir. by DIRECTOR)
	track_re = "^ ( .+? ) ($obrack+|\\s)\\s* ((Dir|Prod)\\. .*)$";
	if (match = title.match(bt_compile_regexp(track_re, subs, "si")))
		{
		title = match[1];
		junk = match[3] + " " + junk;
		}
	
	// TRACK  performed? by ARTIST
	track_re = "^ ( .+? ) \\b (?: performed \\s+ )? by \\b ( .+ )$";
	if (match = title.match(bt_compile_regexp(track_re, subs, "si")))
		{
		track = match[1];
		artist = match[2];
		}
	
	// ARTIST performing TRACK
	track_re = "^ ( .+? ) \\b (?: plays | playing | performs? | performing ) \\b ( .+ )$";
	if (!artist && (match = title.match(bt_compile_regexp(track_re, subs, "si"))))
		{
		artist = match[1];
		track = match[2];
		}
	
	// ARTIST talks about SUBJECT
	track_re = "^ ( .+? ) \\b \\(? \\s* (interview|talks\\sabout) \\s* \\)? \\b \\s* ( .+ ) $";
	if (!artist && (match = title.match(bt_compile_regexp(track_re, subs, "si"))))
		{
		artist = match[1];
		track = match[2].toLowerCase() + " " + match[3];
		}
	
	// GUY interviews ARTIST
	track_re = "^ ( .+? ) \\b (?: interviews | interviewing ) \\b ( .+ )$";
	if (!artist && (match = title.match(bt_compile_regexp(track_re, subs, "si"))))
		{
		artist = match[2];
		track = "interview by " + match[1];
		}

	// "TRACK" ARTIST
	track_re = "^ \\\" ( .+? ) \\\" [,\\s]+ ( .+ )$";
	if (!artist && (match = title.match(bt_compile_regexp(track_re, subs, "si"))))
		{
		track = match[1];
		artist = match[2];
		}

	// ARTIST "TRACK" JUNK?
	track_re = "^ ( .+? ) [,\\s]+ \\\" ( .+ ) \\\" ( .*? ) $";
	if (!artist && (match = title.match(bt_compile_regexp(track_re, subs, "si"))))
		{
		artist = match[1];
		track = match[2];
		junk = match[3] + " " + junk;
		}
	
	// 'TRACK' ARTIST
	track_re = "^ \\' ( .+? ) \\' [,\\s]+ ( .+ )$";
	if (!artist && (match = title.match(bt_compile_regexp(track_re, subs, "si"))))
		{
		track = match[1];
		artist = match[2];
		}

	// ARTIST 'TRACK' JUNK
	track_re = "^ ( .+? ) [,\\s]+ \\' ( .+ ) \\' ( .*? ) $";
	if (!artist && (match = title.match(bt_compile_regexp(track_re, subs, "si"))))
		{
		artist = match[1];
		track = match[2];
		junk = match[3] + " " + junk;
		}
	
	// ARTIST -- TRACK
	track_re = "^ ( .+? ) \\s* --+ \\s* ( .+ )$";
	if (!artist && (match = title.match(bt_compile_regexp(track_re, subs, "si"))))
		{
		artist = match[1];
		track = match[2];
		}
		
	// ARTIST: TRACK
	track_re = "^ ( .+? ) \\s* :+  \\s* ( .+ )$";
	if (!artist && (match = title.match(bt_compile_regexp(track_re, subs, "si"))))
		{
		artist = match[1];
		track = match[2];
		}
	
	// ARTIST-- TRACK
	track_re = "^ ( .+? )     --+ \\s* ( .+ )$";
	if (!artist && (match = title.match(bt_compile_regexp(track_re, subs, "si"))))
		{
		artist = match[1];
		track = match[2];
		}

	// ARTIST - TRACK
	track_re = "^ ( .+? ) \\s+ -   \\s+ ( .+ )$";
	if (!artist && (match = title.match(bt_compile_regexp(track_re, subs, "si"))))
		{
		artist = match[1];
		track = match[2];
		}
	
	// ARTIST- TRACK
	track_re = "^ ( .+? )     -+  \\s* ( .+ )$";
	if (!artist && (match = title.match(bt_compile_regexp(track_re, subs, "si"))))
		{
		artist = match[1];
		track = match[2];
		}
	
	
	// ARTIST live at LOCATION
	track_re = "^ ( .+? ) (live \\s* (at|@) .+ )$";
	if (!artist && (match = title.match(bt_compile_regexp(track_re, subs, "si"))))
		{
		artist = match[1];
		track = match[2];
		}
	
	// clean up artist if required
	track_re = "^ ( .+? ) \\s+ -+ \\s+ ( .+? ) $";
	if (artist && (match = artist.match(bt_compile_regexp(track_re, subs, "si"))))
		{
		artist = match[1];
		junk = match[2] + " " + junk;
		}

	// strip "live at" from tracks
	track_re = "^ ( .+? ) \\s+ $obrack? ( live \\s* (at|@) .* )$";
	if (artist && track &&
			(match = track.match(bt_compile_regexp(track_re, subs, "si"))))
		{
		track = match[1];
		junk = match[2] + " " + junk;
		}
	
	
	// trim leading and trailing crap from our results.
	var gumpf_re = "^ [-\\s\\\"\\'\\`\\|,;:]+ | [-\\s\\\"\\'\\`\\|,;:]+^$";
	gumpf_re = bt_compile_regexp(gumpf_re, undefined, "gs");
	
	title = title.replace(gumpf_re, "");
	if (artist)
		artist = artist.replace(gumpf_re, "");
		
	if (track)
		track = track.replace(gumpf_re, "");
	
	// strip unbalanced parenthesis from our results
	title = bt_strip_unbalanced_parens(title);
	artist = bt_strip_unbalanced_parens(artist);
	track = bt_strip_unbalanced_parens(track);
	
	var result = {
		"title"  : title,
		"artist" : (artist ? artist : ""),
		"track"  : (track ? track : ""),
		"junk"   : (junk ? junk : "") 
		};
	
	return result;
	}

function bt_audio_event(type, ev)
	{
	switch (type)
		{
	case __BT_MEDIA_EVENT.ABORT:
		// fallthrough
	case __BT_MEDIA_EVENT.ERROR:
		bt_handle_error(bt_new_error(__BT_SUBSYSTEM.PLAYER, "bt_audio: audio element encountered an error."));
		break;
	
	case __BT_MEDIA_EVENT.READY:
		bt_debug_log("Media ready.");
		if (_bt_player.state == __BT_PLAYER_STATE.IDLE)
			{
			_bt_player.audio.play();
			_bt_player.state = __BT_PLAYER_STATE.PLAYING;
			}
			
		break;
		
	case __BT_MEDIA_EVENT.ENDED:
		bt_debug_log("Media playback complete.");
		_bt_player.state = __BT_PLAYER_STATE.IDLE;
		_bt_player.errors = 0;
		_bt_player.idle_time = Date.now();
		_bt_player.media.current_track = undefined;
		bt_audio_cue_next_track();
		break;
		}
	}

function bt_init_audio()
	{
	_bt_player.audio = document.createElement("audio");
	var evfn = bt_curry(bt_audio_event);
	_bt_player.audio.addEventListener("abort", evfn(__BT_MEDIA_EVENT.ABORT));
	_bt_player.audio.addEventListener("canplay", evfn(__BT_MEDIA_EVENT.READY));
	_bt_player.audio.addEventListener("ended", evfn(__BT_MEDIA_EVENT.ENDED));
	_bt_player.audio.addEventListener("pause", evfn(__BT_MEDIA_EVENT.PAUSE));
	_bt_player.audio.addEventListener("play", evfn(__BT_MEDIA_EVENT.PLAY));
	_bt_player.audio.addEventListener("error", evfn(__BT_MEDIA_EVENT.ERROR));
	}

function bt_play_audio()
	{
	_bt_player.state = __BT_PLAYER_STATE.IDLE;
	
	// if we have a current track and media already loaded, resume playing it.
	// TODO: in slave mode, we need to seek to an appropriate time
	if (_bt_player.media.current_track && _bt_player.audio.readyState >= 2)
		{
		_bt_player.audio.play();
		_bt_player.state = __BT_PLAYER_STATE.PLAYING;
		}
	else if (!_bt_player.media.current_track)
		{
		// if there's no current track, cue the next track (if any)
		bt_audio_cue_next_track();
		}
		
	// otherwise, just let the various events that should be in progress take effect
	}
	
function bt_pause_audio()
	{
	_bt_player.audio.pause();
	_bt_player.state = __BT_PLAYER_STATE.PAUSED;
	}
	
function bt_audio_set_volume(vol)
	{
	_bt_player.audio.volume = vol;
	}
	
function bt_audio_select_format(fmts)
	{
	if (fmts.length <= 0)
		return undefined;
	
	// prefer mp4 audio, then higher bitrate is better
	fmts = fmts.sort(function(l, r)
		{
		if (l.mime_type == r.mime_type || (!l.mime_type.match(/^audio\/mp4/si) && !r.mime_type.match(/^audio\/mp4/si)))
			return r.bitrate - l.bitrate;
		else
			return l.mime_type.match(/^audio\/mp4/si) ? -1 : 1;
		});
	
	return fmts[0];	
	}
	
function bt_audio_cue_next_track()
	{
	if (!_bt_player.media.next_track)
		{
		bt_ws_request_next_track();
		return false;
		}
	
	// if we don't have formats for this ID yet, we can't play it. Check a request is in progress, and kick one off if not.	
	var fmts = bt_get_fmts(_bt_player.media.next_track.id);
	if (!fmts || fmts.length <= 0)
		{
		if (!bt_is_awaiting_fmts(_bt_player.media.next_track.id))
			{
			bt_await_fmts(_bt_player.media.next_track.id, bt_handle_new_fmts);
			bt_find_fmts(_bt_player.media.next_track.id)
			}
		
		return false;
		}
		
	// select the format to play
	var track = bt_audio_select_format(fmts);
	if (!track)
		throw bt_new_error(__BT_SUBSYSTEM.PLAYER, "bt_audio_cue_next_track: no usable media in formats.");
	
	// parse the title in to useable chunks and set the start time
	track.title = bt_parse_title(track.title);
	track.start = _bt_player.media.next_track.start;
	
	_bt_player.media.next_track = undefined;
	_bt_player.media.current_track = track;
	
	// load the media URL and await an audio event

	var url = track.url;
	if (_bt_debug.use_local)
		url = _bt_debug.local_rsc.audio;
	
	// weirdly firefox will start playing the track immediately when setting the src prop, leading to a double media load.
	// maybe pausing the element first will help?
	_bt_player.audio.pause();
	_bt_player.audio.src = url;
	_bt_player.audio.load();
	return true;
	}	

function bt_player_state_toggle()
	{
	// if we've already encounted a fatal error, do nothing.
	if (_bt_player.state == __BT_PLAYER_STATE.FATAL_ERROR)
		return;
	
	if (_bt_player.state != __BT_PLAYER_STATE.PAUSED)
		bt_pause_audio();
	else
		bt_play_audio();
	}

function bt_create_img(name)
	{
	var img;
	if (name in __bt_ui_images)
		{
		img = document.createElement("img");
		img.src = "data:image/png;base64," + __bt_ui_images[name];
		}
	return img;
	}
	
function bt_update_img(img, name)
	{
	if (name in __bt_ui_images)
		img.src = "data:image/png;base64," + __bt_ui_images[name];
	}
	
function bt_ui_update_play_pause(pp)
	{
	var imname;
	if (_bt_player.state != __BT_PLAYER_STATE.PAUSED)
		imname = "pause";
	else
		imname = "play";
		
	if (pp.hover_state == __BT_HOVER_STATE.HOVER)
		imname += "hover";
		
	bt_update_img(pp, imname);
	}
	
function bt_ui_update_volume(ev)
	{
	var vol_bar = document.getElementById("volbar");
	vol_bar.style.width = ev.offsetX + "px";
	
	// normalise the volume between 10 and 88 pixels.
	var vol = ev.offsetX <= 88 ? ev.offsetX : 88;
	vol = vol > 10 ? vol - 10 : 0;
	vol /= 78;
	
	bt_audio_set_volume(vol);
	
	// store the new volume in the volume cookie
	document.cookie = "__bt_vol_cookie=" + vol;
	}

function bt_ui_apply_volume(vol)
	{
	var vol_width = vol * 78 + 10;
	var vol_bar = document.getElementById("volbar");
	vol_bar.style.width = vol_width + "px";
	bt_audio_set_volume(vol);
	}
	
function bt_set_flavour_text(txt, repeat)
	{
	if (repeat <= 0 && repeat != -1)
		return;
	
	if (!(txt in __BT_FLAVOUR_TEXT))
		return;
	
	var full_text = __BT_FLAVOUR_TEXT[txt];
	var txt_span = document.getElementById("flavour-txt");
	
	// make emotes in to images in the flavour text string
	full_text = full_text.replace(/(?:\s|^):([^:]+):(?:\s|$)/gs, 
		function (match, emote)
			{
			var result = match;
			if (emote in __bt_ui_emotes)
				result = " <img style=\"vertical-align: middle\" src=\"data:image/gif;base64," + __bt_ui_emotes[emote] + "\"/> ";
				
			return result;
			});
	
	// set the new text and vertically centre the text span
	txt_span.innerHTML = full_text;
	txt_span.style.top = Math.round((txt_span.parentNode.getBoundingClientRect().height - txt_span.getBoundingClientRect().height) / 2) + "px"; 
	
	// set the span to its start position, 20 pixels beyond the right hand edge of bounding box
	txt_span.style.left = (txt_span.parentNode.getBoundingClientRect().width + 20) + "px";
	
	_bt_player.flavour_txt.current = txt;
	_bt_player.flavour_txt.active = true;
	_bt_player.flavour_txt.repeat = repeat;
	}

function bt_flavour_text_cycle_complete()
	{
	var txt_span = document.getElementById("flavour-txt");
	
	if (_bt_player.flavour_txt.repeat == -1 || --_bt_player.flavour_txt.repeat)
		{
		// reset the text for the next cycle
		txt_span.style.left = (txt_span.parentNode.getBoundingClientRect().width + 20) + "px";
		}
	else
		{
		_bt_player.flavour_txt.active = false;
		_bt_player.flavour_txt.current = undefined;
		}
	}
	
function bt_current_flavour_text()
	{
	return _bt_player.flavour_txt.current;
	}

function bt_ui_format_time(time)
	{
	var minutes = Math.floor(time / 60);
	var seconds = Math.floor(time % 60);
	
	var result = (minutes >= 10 ? "" : "0") + minutes + ":" + (seconds >= 10 ? "" : "0") + seconds;
	return result;
	}
	
function bt_ui_timer_tick()
	{
	// if the flavour text marquee is active, update it
	if (_bt_player.flavour_txt.active)
		{
		var txt_span = document.getElementById("flavour-txt");
		var new_pos = (txt_span.getBoundingClientRect().left - txt_span.parentNode.getBoundingClientRect().left) - 1;
		txt_span.style.left = new_pos + "px";
		
		// if the right hand side of the flavour text is now 50 or more pixels beyond the left of the bounding rect, the cycle is complete
		if (txt_span.parentNode.getBoundingClientRect().left - 50 >= txt_span.getBoundingClientRect().right)
			bt_flavour_text_cycle_complete();
		}
	
	var track_str = "(Nothing)";
	if (_bt_player.media.current_track)
		{
		track_str = _bt_player.media.current_track.title.title;
		if (_bt_player.media.current_track.title.artist && _bt_player.media.current_track.title.track)
			track_str =  _bt_player.media.current_track.title.track + "\n" + _bt_player.media.current_track.title.artist;
		}
	
	var current_pos =  _bt_player.audio.currentTime;
	var duration =  _bt_player.audio.duration ?  _bt_player.audio.duration : 0;
		
	var time_str = bt_ui_format_time(current_pos) + " / " + bt_ui_format_time(duration);
	
	// if the player is currently idle, don't update the track text until we've been idle a couple of seconds to allow
	// players time to fetch the next track metadata
	if (_bt_player.state != __BT_PLAYER_STATE.IDLE || (Date.now() - _bt_player.idle_time) < 2) 
		document.getElementById("now-playing").innerText = track_str + "\n" + time_str;
	
	// if the websocket is currently not connected, try connecting again if the backoff period has expired
	if (_bt_player.ws.mode == __BT_WS_MODE.NOCONN && _bt_player.state != __BT_PLAYER_STATE.FATAL_ERROR)
		{
		// if the connecting flavour text isn't showing, show it
		if (bt_current_flavour_text() != "connecting")
			bt_set_flavour_text("connecting", -1);
		
		// 5 seconds backoff base
		var back_off_base = 5;
		var back_off_time = (back_off_base ** _bt_player.ws.backoff) * 1000;
		var elapsed = Date.now() - _bt_player.ws.last_connect;
		
		if (elapsed >= back_off_time)
			bt_ws_init();
		}
		
	// if the banger server is connected and player is idle, set the idle flavour text
	if (_bt_player.state == __BT_PLAYER_STATE.PAUSED && _bt_player.ws.mode != __BT_WS_MODE.NOCONN && _bt_player.ws.mode != __BT_WS_MODE.CONNECTING)
		{
		if (bt_current_flavour_text() != "idle")
			bt_set_flavour_text("idle", -1);
		}
	}
	
function bt_ui_toggle_debug()
	{
	var debug_link = document.getElementById("debuglink");
	var debug_div = document.getElementById("debug");
	
	if (_bt_debug.debug_show)
		{
		debug_div.style.display = "none";
		debug_link.innerText = "Show Debug";
		}
	else
		{
		debug_div.style.display = "block";
		debug_link.innerText = "Hide Debug";
		}
		
	_bt_debug.debug_show = !_bt_debug.debug_show;
	}
	
function bt_ui_toggle_dj()
	{
	var auth_pane = document.getElementById("authpane");
	
	// TOOD: already logged in to mod or master mode
	if (_bt_player.show_dj)
		{
		auth_pane.style.display = "none";
		}
	else
		{
		auth_pane.style.display = "block";
		}
	
	_bt_player.show_dj = !_bt_player.show_dj;
	}

function bt_ui_events(target, type, ev)
	{
	var result = true;
	
	if (target == __BT_UI_ELEMENT.PAUSE_PLAY)
		{
		switch (type)
			{
		case __BT_UI_EVENT.MOUSEIN:
			ev.srcElement.hover_state = __BT_HOVER_STATE.HOVER;
			bt_ui_update_play_pause(ev.srcElement);
			break;
			
		case __BT_UI_EVENT.MOUSEOUT:
			ev.srcElement.hover_state = __BT_HOVER_STATE.NONE;
			bt_ui_update_play_pause(ev.srcElement);
			break;
			
		case __BT_UI_EVENT.CLICK:
			bt_player_state_toggle();
			bt_ui_update_play_pause(ev.srcElement);
			break;
			}
		}
	else if (target == __BT_UI_ELEMENT.VOLUME)
		{
		switch (type)
			{
		case __BT_UI_EVENT.MOUSEIN:
			bt_update_img(ev.srcElement, "volumehover");
			break;
			
		case __BT_UI_EVENT.MOUSEOUT:
			bt_update_img(ev.srcElement, "volume");
			ev.srcElement.button_state = __BT_BUTTON_STATE.UP;
			break;
		
		case __BT_UI_EVENT.MOUSEDOWN:
			ev.srcElement.button_state = __BT_BUTTON_STATE.DOWN;
			bt_ui_update_volume(ev);
			break;
		
		case __BT_UI_EVENT.MOUSEUP:
			ev.srcElement.button_state = __BT_BUTTON_STATE.UP;
			bt_ui_update_volume(ev);
			break;
			
		case __BT_UI_EVENT.MOUSEMOVE:
			// There seems to be no actual, browser independant way of finding out the mouse button
			// state during a move event. Sigh.
			if (ev.srcElement.button_state == __BT_BUTTON_STATE.DOWN)
				bt_ui_update_volume(ev);
			break;
			}
		}
	
	return result;
	}
	
function bt_init_ui()
	{
	var evfn = bt_curry(bt_ui_events);
	
	// define a class UI elements use so they can't be dragged
	var nodrag = document.createElement("style");
	nodrag.type = "text/css";
	nodrag.innerHTML = ".nodrag {" +
		"user-drag: none;" +
		"user-select: none;" +
		"-moz-user-select: none;" +
		"-webkit-user-drag: none;" +
		"-webkit-user-select: none;" +
		"-ms-user-select: none;" +
		"}";
	document.getElementsByTagName("head")[0].appendChild(nodrag);
	document.body.style.padding = "10px 10px 10px 10px";
	
	// create link styles
	var link_style = document.createElement("style");
	link_style.type = "text/css";
	link_style.innerHTML = 
		".bt_links a:link { color: white; text-decoration: none; } " +
		".bt_links a:visited { color: white; text-decoration: none; } " + 
		".bt_links a:hover { color: gold; text-decoration: none; } " +
		".bt_links a:active { color: gold; text-decoration: none; } ";
	document.getElementsByTagName("head")[0].appendChild(link_style);
	
	// the two column layout:
	// left column: player, debug
	// right column, DJ panes. Usually hidden.
	
	var main_columns = document.createElement("div");
	main_columns.style.display = "grid";
	main_columns.style.gridTemplateColumns = "700px auto";
	
	// the column divs to which content is added.
	var left_div = document.createElement("div");
	var right_div = document.createElement("div");
	
	main_columns.appendChild(left_div);
	main_columns.appendChild(right_div);
	
	// main player container div
	var main_div = document.createElement("div");
	main_div.style.background = "linear-gradient(#6b1e62 80%, #370632)";
	main_div.style.display = "table";
	main_div.style.border = "2px solid black";
	var hdr = bt_create_img("header");
	hdr.className = "nodrag";
	main_div.appendChild(hdr);
	
	var lb = document.createElement("br");
	main_div.appendChild(lb);
	
	// The controls pane, with the current track text, the play/pause button and the volume slider
	
	var ctrl_box = document.createElement("div");
	ctrl_box.style.display = "grid";
	ctrl_box.style.gridTemplateColumns = "140px 370px 140px"
	ctrl_box.style.height = "140px";
	
	// The play/pause button
	
	var pp_box = document.createElement("div");
	pp_box.style.padding = "10px 0px 0px 10px";
	var pp = bt_create_img("play");
	pp.className = "nodrag";
	pp.setAttribute("draggable", false);
	pp.hover_state = __BT_HOVER_STATE.NONE;
	pp.addEventListener("mouseenter", evfn(__BT_UI_ELEMENT.PAUSE_PLAY, __BT_UI_EVENT.MOUSEIN));
	pp.addEventListener("mouseout", evfn(__BT_UI_ELEMENT.PAUSE_PLAY, __BT_UI_EVENT.MOUSEOUT));
	pp.addEventListener("click", evfn(__BT_UI_ELEMENT.PAUSE_PLAY, __BT_UI_EVENT.CLICK));
	
	pp_box.appendChild(pp);
	
	// The current track text
	
	var playing_box = document.createElement("div");
	playing_box.id = "now-playing";
	playing_box.style.textAlign = "center";
	playing_box.style.whiteSpace = "pre";
	playing_box.style.overflow = "hidden";
	playing_box.style.fontFamily = "Verdana, Geneva, sans-serif"
	playing_box.style.fontSize = "16px";
	playing_box.style.color = "white";
	playing_box.style.padding = "20px 5px 0px 5px"
	
	// The volume slider
	
	var vol_box = document.createElement("div");
	vol_box.style.padding = "10px 0px 0px 35px";
	
	var vol_background = document.createElement("div");
	vol_background.style.position = "relative";
	vol_background.style.zOrder = "0";
	vol_background.style.left = "0px";
	vol_background.style.top = "0px";
	vol_background.style.backgroundColor = "white";
	vol_background.style.width = "99px";
	vol_background.style.height = "83px";
	
	var vol_bar = document.createElement("div");
	vol_bar.id = "volbar";
	vol_bar.style.position = "relative";
	vol_bar.style.zOrder = "50";
	vol_bar.style.left = "0px";
	vol_bar.style.top = "-83px";
	vol_bar.style.backgroundColor = "#fdcc22";
	vol_bar.style.width = "10px";
	vol_bar.style.height = "83px";
	
	var vol_overlay = document.createElement("div");
	vol_overlay.style.position = "relative";
	vol_overlay.style.left = "0px";
	vol_overlay.style.top = "-166px";
	vol_overlay.style.zOrder = "100";
	
	var vol_interface = bt_create_img("volume");
	vol_interface.className = "nodrag";
	vol_overlay.appendChild(vol_interface);
	vol_interface.button_state = __BT_BUTTON_STATE.UP;
	vol_interface.addEventListener("mouseenter", evfn(__BT_UI_ELEMENT.VOLUME, __BT_UI_EVENT.MOUSEIN));
	vol_interface.addEventListener("mouseout", evfn(__BT_UI_ELEMENT.VOLUME, __BT_UI_EVENT.MOUSEOUT));
	vol_interface.addEventListener("mousedown", evfn(__BT_UI_ELEMENT.VOLUME, __BT_UI_EVENT.MOUSEDOWN));
	vol_interface.addEventListener("mouseup", evfn(__BT_UI_ELEMENT.VOLUME, __BT_UI_EVENT.MOUSEUP));
	vol_interface.addEventListener("mousemove", evfn(__BT_UI_ELEMENT.VOLUME, __BT_UI_EVENT.MOUSEMOVE));
	
	vol_box.appendChild(vol_background);
	vol_box.appendChild(vol_bar);
	vol_box.appendChild(vol_overlay);
	
	ctrl_box.appendChild(pp_box);
	ctrl_box.appendChild(playing_box);
	ctrl_box.appendChild(vol_box);
	
	main_div.appendChild(ctrl_box);
	
	var flavour_box = document.createElement("div");
	flavour_box.style.padding = "0px 0px 0px 10px";
	flavour_box.style.height = "82px";
	var speech = bt_create_img("speech");
	var mrdestructoid = bt_create_img("mrdestructoid");
	
	var flavour_txt_box = document.createElement("div");
	flavour_txt_box.style.position = "relative";
	flavour_txt_box.style.top = "-60px";
	flavour_txt_box.style.left = "20px";
	flavour_txt_box.style.width = "450px";
	flavour_txt_box.style.height = "30px";
	flavour_txt_box.style.overflow = "hidden";
	
	var flavour_txt_span = document.createElement("span");
	flavour_txt_span.id = "flavour-txt";
	flavour_txt_span.style.position = "relative";
	flavour_txt_span.style.left = "-30px";
	flavour_txt_span.style.whiteSpace = "pre";
	flavour_txt_span.style.fontFamily = "Tahoma, Geneva, sans-serif";
	flavour_txt_span.style.color = "black";
	flavour_txt_span.style.fontSize = "18px";
	
	flavour_txt_box.appendChild(flavour_txt_span);
	
	flavour_box.appendChild(speech);
	flavour_box.appendChild(mrdestructoid);
	flavour_box.append(flavour_txt_box);
	
	main_div.appendChild(flavour_box);
	
	var credit_box = document.createElement("div");
	credit_box.style.fontFamily = "Verdana, Geneva, sans-serif"
	credit_box.style.color = "white";
	credit_box.style.zIndex = 0;
	credit_box.style.fontSize = "12px";
	credit_box.style.padding = "8px 12px 12px 17px";
	credit_box.innerText = "Written by JeevesMkII";
	
	var tools_div = document.createElement("div");
	tools_div.className = "bt_links";
	tools_div.style.float = "right";
	tools_div.style.fontWeight = "bold";
	tools_div.style.position = "relative";
	tools_div.style.zIndex = 100;
	tools_div.innerHTML = "<a href=\"javascript:bt_ui_toggle_dj();\">DJ Login</a> | <a id=\"debuglink\" href=\"javascript:bt_ui_toggle_debug();\">Show Debug</a>";
	credit_box.appendChild(tools_div);
	
	main_div.appendChild(credit_box);
	left_div.appendChild(main_div);
	
	// the debug box
	left_div.appendChild(lb);
	
	var debug_div = document.createElement("div")
	debug_div.id = "debug";
	debug_div.style.width = "660px";
	debug_div.style.height = "400px";
	debug_div.style.display = "none";
	
	var debug_form = document.createElement("form");
	debug_form.name = "debugform";
	
	var debug_area = document.createElement("textarea");
	debug_area.name = "debugbox";
	debug_area.id = "debugbox";
	debug_area.readOnly	= true;
	debug_area.style.height = "400px";
	debug_area.style.width = "656px";
	
	debug_form.appendChild(debug_area);
	debug_div.appendChild(debug_form);
	left_div.appendChild(debug_div);
	
	// the auth pane
	var auth_pane = document.createElement("div");
	auth_pane.id = "authpane";
	auth_pane.style.display = "none";
	
	var auth_header = document.createElement("h3");
	auth_header.innerText = "Enter password:";
	auth_pane.appendChild(auth_header);
	
	var auth_form = document.createElement("form");
	auth_form.name = "authform";
	
	var pass_input = document.createElement("input");
	pass_input.type = "password";
	pass_input.name = "authpass";
	pass_input.id = "authpass";
	auth_form.appendChild(pass_input);
	
	var login_button = document.createElement("input");
	login_button.type = "button";
	login_button.name = "login";
	login_button.id = "loginbtn";
	login_button.value = "Login";
	login_button.addEventListener("click", bt_ws_request_auth);
	auth_form.appendChild(login_button);
	auth_pane.appendChild(auth_form);
	
	auth_spinner = document.createElement("img");
	auth_spinner.src = "data:image/png;base64," + __bt_ui_images["hourglass"];
	auth_pane.appendChild(auth_spinner);
	
	right_div.appendChild(auth_pane);
	
	document.body.appendChild(main_columns);
	
	// Thanks firefox, you asshole
	// They removed the CSS way to stop individual item drags.
	// So now we have to do this hack.
	document.addEventListener("dragstart", function(ev) { ev.preventDefault(); }, true);
	
	// we store the volume in a cookie, not indexedDB because god knows what yt does with indexedDB and I don't want to fuck with it.
	var vol = 0.75;
	var vol_cookies = document.cookie.split(";").filter(cookie => cookie.trim().startsWith("__bt_vol_cookie="));
	if (vol_cookies.length >= 1)
		vol = vol_cookies[0].trim().slice("__bt_vol_cookie=".length).trim();
	
	bt_ui_apply_volume(vol);
	
	// set up the UI refresh interval
	setInterval(bt_ui_timer_tick, 25);
	}

function bt_ws_handle_mode(args)
	{
	if (args.length != 1)
		throw bt_new_error(__BT_SUBSYSTEM.WEBSOCKET, "bt_ws_handle_mode: bad mode command.");
		
	switch (args[0])
		{
	case "master":
		_bt_player.ws.mode = __BT_WS_MODE.MASTER;
		break;
		
	case "slave":
		// fucking slaves, get your ass back here!
		_bt_player.ws.mode = __BT_WS_MODE.SLAVE;
		break;
			
	case "free":
		// request the master playlist
		_bt_player.ws.mode = __BT_WS_MODE.FREE;
		bt_ws_queue_command("playlist", ["master"], "playlist");
		break;
		
	case "mod":
		_bt_player.ws.mode = __BT_WS_MODE.MOD;
		break;
		}
	
	bt_debug_log("Entering " + args[0] + " mode.");
	}
	
function bt_ws_handle_playlist(args)
	{
	if (args.length != 2)
		throw bt_new_error(__BT_SUBSYSTEM.WEBSOCKET, "bt_ws_handle_playlist: bad playlist command.");
	
	bt_debug_log("Loaded playlist " + args[0] + ".");
	
	// TODO: master mode, slave and mod needs to do something different here
	bt_ws_queue_command("track", [], "track");;
	}
	
function bt_ws_handle_challenge(args)
	{
	if (args.length != 2)
		throw bt_new_error(__BT_SUBSYSTEM.WEBSOCKET, "bt_ws_handle_challenge: bad challenge command.");
		
	if (!_bt_player.ws.auth_client_random || !_bt_player.ws.auth_pass)
		throw bt_new_error(__BT_SUBSYSTEM.WEBSOCKET, "bt_ws_handle_challenge: unexpected auth challenge.");
	
	if (args[0].length != 12 || args[1].length != 32)
		throw bt_new_error(__BT_SUBSYSTEM.WEBSOCKET, "bt_ws_handle_challenge: malformed challenge arguments");
	
	var pass = _bt_player.ws.auth_pass;
	var crand = _bt_player.ws.auth_client_random;
	var srand = bt_base64_decode(args[0]);
	var challenge = bt_base64_decode(args[1]);
	_bt_player.ws.auth_client_random = undefined;
	_bt_player.ws.auth_pass = undefined;
	
	if (srand.length != 8 || challenge.length != 24)
		throw bt_new_error(__BT_SUBSYSTEM.WEBSOCKET, "bt_ws_handle_challenge: malformed challenge arguments.")
	
	bt_ws_auth_challenge_response(pass, crand, srand, challenge, bt_ws_send_challenge_response)
	}


function bt_ws_handle_track(args)
	{
	// the track command takes up to two arguments. First is the yt ID of the track, second is timestamp to begin playback at, valid only in slave or mod mode.
	if (args.length < 1)
		throw bt_new_error(__BT_SUBSYSTEM.WEBSOCKET, "bt_ws_handle_track: bad track command.");
		
	var track_id = args[0];
	// TODO: there should probably be more to this sanity check
	if (track_id.length > 20)
		throw bt_new_error(__BT_SUBSYSTEM.WEBSOCKET, "bt_ws_handle_track: malformed track arguments.");
	
	// whle track commands are unsolicited in slave/mod mode, they may be directly solicted in free/master mode.
	// so check if this was solicited, and fulfil it if so.
	if (_bt_player.ws.current && _bt_player.ws.current.expect == "track")
		_bt_player.ws.current = undefined;
	
	bt_debug_log("Next track is " + args[0] + ".");
	
	
	// TODO: if slave/mod mode, trigger track immediately
	_bt_player.media.next_track = { "id" : track_id, "start" : 0 };
	if (_bt_player.state == __BT_PLAYER_STATE.IDLE)
		bt_audio_cue_next_track();
	}
	
function bt_ws_handle_log(args)
	{
	if (args.length != 1)
		throw bt_new_error(__BT_SUBSYSTEM.WEBSOCKET, "bt_ws_handle_log: malformed websocket log command.");
	
	bt_debug_log(args[0]);
	}

function bt_ws_parse_message(msg)
	{
	var cmds = [];
	var current_cmd = [];
	var line_len = 0;
	var idx = 0;
	
	while ((idx = msg.search(/\s+/g)) > 0)
		{
		if (msg.startsWith("\""))
			{
			// quoted string argument, scan for the terminating quote
			var done = false;
			var escaped = false;
			var arg = "";
			var i = 1;
			
			for (; i < msg.length; i++)
				{
				switch (msg[i])
					{
				case "\\":
					if (escaped)
						{
						arg += msg[i];
						escaped = false;
						}
					else
						escaped = true;
					
					break;
				
				case "\"":
					if (escaped)
						{
						arg += msg[i];
						escaped = false;
						}
					else
						done = true;
						
					break;
				
				default:
					if (escaped)
						throw bt_new_error(__BT_SUBSYSTEM.WEBSOCKET, "bt_ws_parse_message: bad escape sequence in command");
					arg += msg[i];
					
					break;
					}
					
				if (done)
					break;
				}
			
			if (!done)
				bt_new_error(__BT_SUBSYSTEM.WEBSOCKET, "bt_ws_parse_message: unterminated quoted string in command.");
			
			current_cmd.push(arg);
			idx = ++i;
			}
		else
			{
			// reqular, unqoted arg
			current_cmd.push(msg.slice(0, idx));
			}
			
		// chomp the whitepace
		var ws = msg.slice(idx).match(/^\s+/g);
		if (!ws)
			bt_new_error(__BT_SUBSYSTEM.WEBSOCKET, "bt_ws_parse_message: garbage characters after terminating quote.")
		
		msg = msg.slice(idx + ws[0].length);
		line_len += idx + ws[0].length;
			
		if (ws[0].includes("\r\n"))
			{
			// message line terminates, discard empty lines
			if (current_cmd.length != 0)
				{
				var cmd = current_cmd.shift();
				cmd = Object.keys(__BT_WS_COMMAND).find(key => __BT_WS_COMMAND[key].cmd == cmd);
				
				// ignore unknown commands
				if (cmd)
					cmds.push({"cmd" : __BT_WS_COMMAND[cmd], "args" : current_cmd});
				
				current_cmd = [];
				line_len = 0;
				}
				
			continue;	
			}
		
		if (line_len > 256)
			throw bt_new_error(__BT_SUBSYSTEM.WEBSOCKET, "bt_ws_parse_message: command line length exceeded.");
		}
		
	return cmds;
	}
	
function bt_ws_send_next_command()
	{
	if (_bt_player.ws.current)
		return;
	
	// send commands until we've sent one that requires a response
	while (_bt_player.ws.queue.length > 0)
		{
		_bt_player.ws.current = _bt_player.ws.queue.shift();
		var cmd = _bt_player.ws.current.cmd;
		_bt_player.ws.current.args.forEach(arg => cmd += " " + arg);
	
		_bt_player.ws.socket.send(cmd + "\r\n");
		
		if (!_bt_player.ws.current.expect)
			_bt_player.ws.current = undefined;
		else
			break;
		}
	
	}

function bt_ws_queue_command(cmd, args, expect)
	{
	_bt_player.ws.queue.push({"cmd" : cmd, "args" : args, "expect" : expect });
	}
	
function bt_ws_events(type, ev)
	{
	switch (type)
		{
	case __BT_WS_EVENT.OPEN:
		bt_debug_log("Connection successful.");
		_bt_player.ws.backoff = 0;
		break;
		
	case __BT_WS_EVENT.MESSAGE:
	
		try
			{
			// parse and dispatch messages
			var cmds = bt_ws_parse_message(ev.data);
			cmds.forEach(cmd =>
				{
				if (!cmd.cmd.unsolicited)
					{
					// check we're expecting this command. Fulfil the current expectation if so.
					if (_bt_player.ws.current && _bt_player.ws.current.expect == cmd.cmd.cmd)
						_bt_player.ws.current = undefined;
					else
						throw bt_new_error(__BT_SUBSYSTEM, "bt_ws: websocket protocol sequence error.");
					}
				
				cmd.cmd.handler(cmd.args);
				});
			}
		catch (err)
			{
			bt_handle_error(err);
			}
		
		// if we satisfied the current command, send the next
		bt_ws_send_next_command();
		break;
	
	case __BT_WS_EVENT.CLOSE:
		bt_debug_log("Banger server connection closed.");
		_bt_player.ws.mode = __BT_WS_MODE.NOCONN;
		break;
	
	case __BT_WS_EVENT.ERROR:
		// fallthrough
	default:
		bt_handle_error(bt_new_error(__BT_SUBSYSTEM.WEBSOCKET, "bt_ws: websocket error."));
		break;
		}
	
	}
	
function bt_ws_auth_generate_client_random()
	{
	var crandom = new Uint8Array(8);
	crypto.getRandomValues(crandom);
	
	return crandom;
	}
	
function bt_ws_auth_challenge_response(pass, crand, srand, challenge, callback)
	{
	let _bt_ws_auth_worker = async function(pass, challenge)
		{
		var key_material = await crypto.subtle.digest("SHA-256", pass);
		var key_material_b = new Uint8Array(key_material);
		var mac_key = await crypto.subtle.importKey("raw", key_material_b, {name : "HMAC", hash : "SHA-256"}, true, ["sign"]);
		var sig = crypto.subtle.sign("HMAC",  mac_key, challenge);
		
		return sig;
		};
	
	pass = bt_str_to_char_array(pass);
	
	// Responsd with HMAC(crand + srand + challenge)
	msg = bt_char_array_concat(crand, srand);
	msg = bt_char_array_concat(msg, challenge);
	
	_bt_ws_auth_worker(pass, msg)
		.then(resp => callback(resp))
		.catch(err => bt_handle_error(bt_new_error(__BT_SUBSYSTEM.WEBSOCKET, "bt_ws_auth_challenge_response: crypto error.")));
	}
	
function bt_ws_init()
	{
	bt_debug_log("Attempting to connect to banger server at " + __BT_WS_HOST + ":" + __BT_WS_PORT);
	
	_bt_player.ws.mode = __BT_WS_MODE.CONNECTING;
	_bt_player.ws.last_connect = Date.now();
	_bt_player.ws.backoff++;
	
	var evfn = bt_curry(bt_ws_events);
	_bt_player.ws.socket = new WebSocket("wss://" + __BT_WS_HOST + ":" + __BT_WS_PORT);
	_bt_player.ws.socket.addEventListener("open", evfn(__BT_WS_EVENT.OPEN));
	_bt_player.ws.socket.addEventListener("close", evfn(__BT_WS_EVENT.CLOSE));
	_bt_player.ws.socket.addEventListener("message", evfn(__BT_WS_EVENT.MESSAGE));
	_bt_player.ws.socket.addEventListener("error", evfn(__BT_WS_EVENT.ERROR));
	}

function bt_ws_close()
	{
	_bt_player.ws.current = undefined;
	_bt_player.ws.queue = [];
	_bt_player.ws.socket.close();
	}

function bt_ws_request_next_track()
	{
	// free/master mode only. others shouldn't send unsolicited track requests
	// TODO: check WS state
	
	if (_bt_player.ws.mode != __BT_WS_MODE.FREE && _bt_player.ws.mode != __BT_WS_MODE.NASTER)
		return;
	
	bt_ws_queue_command("track", [], "track");
	// send immediately if not processing other commands
	bt_ws_send_next_command();
	}

function bt_ws_request_auth(ev)
	{
	// if we're already in an authenticated mode, ignore this request
	if (_bt_player.ws.mode == __BT_WS_MODE.MASTER || _bt_player.ws.mode == __BT_WS_MODE.MOD)
		return;
	
	var passbox = document.getElementById("authpass");
	
	_bt_player.ws.auth_client_random = bt_ws_auth_generate_client_random();
	_bt_player.ws.auth_pass = passbox.value;
	
	bt_ws_queue_command("auth", [bt_base64_encode(_bt_player.ws.auth_client_random)], "challenge");
	// send immediately if not processing other commands
	bt_ws_send_next_command();
	}

function bt_ws_send_challenge_response(resp)
	{
	var resp_bytes = new Uint8Array(resp);
	bt_ws_queue_command("challenge-response", [bt_base64_encode(resp_bytes)]);
	// send immediately if not processing other commands
	bt_ws_send_next_command();
	}

function bt_main()
	{
	// if we're running from localhost, use the local test files
	var not_youtube = false;
	if (window.location.host == "localhost")
		_bt_debug.use_local = true;
	else if (window.location.host != "www.youtube.com")
		{
		not_youtube = true;
		_bt_player.state = __BT_PLAYER_STATE.FATAL_ERROR;
		}
	
	document.body.innerHTML = "";
	document.getElementsByTagName('head')[0].innerHTML = "";
	
	document.title = "Bangertron 9000";
	
	bt_init_audio();
	bt_init_ui();
	
	bt_debug_log("Bangertron 9000 version " + __BT_VERSION + " by JeevesMkII. Running...");
	if (not_youtube)
		{
		bt_debug_log("Bangertron 9000 needs to be run in a youtube tab. Exiting.");
		bt_set_flavour_text("not_youtube", -1);
		}
	}

// The magic bookmarklet incantation:	
// javascript:(function(){ 
//	var script = document.createElement('script'); 
//	script.src = "http://localhost:8080/bangertron,js";
//	document.getElementsByTagName('head')[0].appendChild(script);
//})();

const __bt_ui_images = 
	{
	header : "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",
	play : "iVBORw0KGgoAAAANSUhEUgAAAGMAAABTCAYAAACLQbk4AAAABmJLR0QAAAAAAAD5Q7t/AAAACXBIWXMAAC4jAAAuIwF4pT92AAAAB3RJTUUH5AsJDToNGBm8OAAAABl0RVh0Q29tbWVudABDcmVhdGVkIHdpdGggR0lNUFeBDhcAAAS1SURBVHja7Z3NbttGFIUPZdpS4rZxEqRAsmhRaNdtXiPrJKtu+iCF3sbOOq/jfdAkdi3/WxSnC56JLmhbIqkZcoa8AwwsS4Jgz6dzDu+VhkyMMQmAEYAUwJhzl/clAAznQswMwBJALh6Xo/y705EkCfo4EmPMDkE8AfCM8wmB2P86A3AL4BLAFecdwSwFkDIYhVJjpFTAmBDeAHgN4ID3jYQqLgH8J+aFgLIksLyklsQnGGNMr8CkAHYEjNcAfgfwAsCEMKwyrgHMAZwC+AbgBMAZId1QOXdrLCzxqRYLJmYoVhm7tKYDgnhOGDt8Xk51PONjLwnlOwGdc14S2u0aC2sFSoxgLAwLZEwIk3w2/ds+afTP8SGBTADsA/iFUF4RwpxKOQ3FwmJUSyosZCRsK5VPymfTj4RyJKDtUyk3VMRZDQvrRC2hQ5GLnpR+FuMdf34G8tn0A6F8KkH5Wahlk4Vp4FeA8TiQ+1DeCws7ArAnwKyzsLkGfnUYm4eAQgv7sMHCroSFnYQa+CFAeQhGUgtKdQt7AeDXUAM/BAtLnbzKZgubbBn4g7Cw1OmrPW5hVi2TBoE/GAtLvbzqfQtrGviDsrDUO+76gT9YC0tbM8TNFjaO0cJcgmkPRk8tzKVa2ofRroVFFfjdwvBrYdEFfhgw3FtYlG2XsGAMvO0SLozmFhZF2+UhKOHDqGdh0bRdHoISD4yetl2MMT+AxAmjZzWLVUncMHrWdukPjB60XfoHI2IL6y+MCNsuw4ARSdtlWDACb7sME0agbReF0X3bxSiMcNoudkOSwui47WLVkgAwCqMZlG1qlnNCucFqS14OIFEYW1hYg5rlqwBzLmxsASBXGH4D/2nJwp4TxldmyzeCAYBMYfi1sEOsdhDvA/gJxe6wA0LaFbmhAe7ZwsqbjGzoj7n2Ge3qCsBSYbRrYYdY7SC+ozrsNu+dka6cZyhCMfls+jGfTf+iKuy0Jz9Qm2pTKaO3x4ei+MvEYa0WfW2N0dvjIxZ5dzyUPefhrq05FpoZ/iHYLdsLgrgkgBMAXzjnrMr10NYDgE9UwRKrE99coWgenj5QZ5wpDH9WlFEFt1qBd6cCC+Fa2FGd3pQGuAMVLLiwTT54+lF9Q7u2jSEshAouHlFBnY9k9dB2CyuygWxV0OTLCpAgFMb2gdzkazz3ICgMd4Fc5fNurIOgMPwE8lbnakwVgpdArgVhsDBaCOTaEAYHo4tAVhgBBbLCCCiQBw0jtECuOvqxpy/wQK4DImoYa6womECuCiFaGDWtqNNArgohKhhbWlFngVwVQhQwHNYGnaigKoRgYcRWG2wLIEgYsdYGLiAEAyPW2sAVgM5hxF4buIbQCYwYmnVdQGgNxpADORgYGsgBwNBAdgvDOLKiwQdyq8rQQPYLwzRUgQayYxjyq4bF7XcayF3AMHyXZmLBLYTyhg8NZF9/qzHmKYp9yb8B+BPAHyjOGFO+tuu1BrJ/ZdjFlnYDrK7tmvGdLgPZZoEGsmMY9vLScxR7zBK+0/d4O+Oinz4SyJmqwB2MnIs6R3Ep0RsA//KxRCjjgtPuurEQjEJwlxkjQthDsVt/n7dtuFtY0o4WXSqhjyAA4H8s/q6ovKcqnwAAAABJRU5ErkJggg==",
	playhover : "iVBORw0KGgoAAAANSUhEUgAAAGMAAABTCAYAAACLQbk4AAAABmJLR0QAAAAAAAD5Q7t/AAAACXBIWXMAAC4jAAAuIwF4pT92AAAAB3RJTUUH5AsJDgQvjvpY+AAAABl0RVh0Q29tbWVudABDcmVhdGVkIHdpdGggR0lNUFeBDhcAAATbSURBVHja7Z3fUtNAGMVP2hBbxPEvONMLvfIN0DtvvOadGJ8Jr30A4C0cOypCEYFg2hIvetZ+1JYm7SbZTb7M7NApmTJ8v55zdr9k2yDe77QAtABsAOhwRADamB63AIYAEo4hgBGfv+U5qThfPrZ+dD/eoI5HCCAgiIcAngF4yscRIaUsfAzgN8cVgD8EMxZQZiEUAiXe79QSSsjRIYjXAF4BeM7nQhY5IYSfAE45fhHKDWGNCGa84G+lRUGpC5iQdtShIl4BeANgG8CmsKohCz8AcALgO4AfAM4I6ZrKMRY2FooxIAJVy3IYLVrSQypiG8DODIwxi2x+/5Iq+UFA5xwXBHNTtYX5CMbAaBNIlxA2o6D3wZyUpP1DFnYTwBZVtAOgR7s6I5ifSyxMBr5myxwYoIW0RYaE8qQo6L0jlGOGfRfAI+bMNa3KAJlnYTcM/KEG/nIYEFBawt+BPf78BERBb1dAiZg1jwA8oVpe3GNhEowG/j1TWwMiWHjmHCgCzAOqZZGFnQgLu9TAz6aM5YeAQgvbXWJhlwLIiauB7wKUeTCCXFCyW9gOAeQJ/EZZWGjlVbJZWJ7Ab6SFhVZf7X4LiwSULIHfOAsLC3nVBRaWI/AbaWFh4bjzB35jLSwszRCXW1jHRwuzCaY8GOVamJdtl/JhFGthXrddqoVRjIV523ZxA4Y9C/O67eIWjIa3XdyFsbqFedF2mQfFfRj5LcyLNcs8KP7AqGnbJd7v/APiJ4yatV2MSvyGUbO2S31g1KDtUj8YHrdd6gvDw7ZLM2B40nZpFgzH2y7NhOFo20VhVN92SRVGdW2X0YxaAgNEYVTXdjFqMcpIFcYaUFZcs5zTwmJOj41SVBnrWNgKa5ZvIvjl9DgBMFYYxQb+1oyF7RBKn2C+UTEAMFQYxVrY0YyFPcZk95fZyBrJWZbCKNbC3gq1hAJMl5aWiGmw2lTJFnaI6XbumBa2SYW0W1q5gqEIxURB710U9N5TJRscZsNSoMooUSnJQf9QTGeHYhGY6jqjpCM56B9j+nEf12L9ca5T2/IgHGHam4oxaTKes2XyFcAXQol1alucCsbCihJC+CXaJHKdMWCLRGFYhmAA/GGBdQVekQpGhHDFIi9qry/qTWmAW1BBwsLmvfAku7Y6m1oTggFwMaOCZZdkZ69nAHo9Yy0rMoF8ivw3K9wBAL3SZy2QV7mN5z8ICsNeIGe5wS3T5zcqDHuBnEsFCqOYQJ53jxTyQGgsjBICOTeExsGoIpAVhkOBrDAcCuRGw3AtkLMe9djT53gg5wHhNYx7rMiZQM4KwVsYGa3IiUDOCsErGCtaUeWBnBWCFzDWWBtUGsh5ITgLw/LaoPRAzgvASRi+rg1sQHAGhq9rA1sAKofh+9rANoRKYPjQrKsCQmkwfGvWlQ2gFBgayA7A0EC2CyO1ZEWND+RSlaGBbB+G/MfTFVWggVyAMtI779A9DeQqYKQz7/aRgHAofqeBXDCMW0y/odIUO07S/mccoIXpNx5faSCXkxkJi33GQgeY7FVus6jXQgFmw8epBrJ9GCMWc4DJHrMW3+ldnjPE9BuPT0QgXwoAGsiWYIxZ1AGVEGPyQSQbPGckcuKCEEwejETeqBVZygwTzgM+HohwvyUsE8rz7KhUCHUEAQB/AZP18QOYpsc1AAAAAElFTkSuQmCC",
	pause : "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",
	pausehover : "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",
	volume : "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",
	volumehover : "iVBORw0KGgoAAAANSUhEUgAAAGMAAABTCAYAAACLQbk4AAAABmJLR0QAAAAAAAD5Q7t/AAAACXBIWXMAAC4jAAAuIwF4pT92AAAAB3RJTUUH5AsKCiMo3+d4DAAAABl0RVh0Q29tbWVudABDcmVhdGVkIHdpdGggR0lNUFeBDhcAAAUXSURBVHja7Z3LbttGGEbPPzO8SZRlx86iNdB3aNIn6rZ9iTxgeklXTdFFHiBdBI5JDjkzXVCW5EuMxJJtUpwBCBqCIRM6/ng4FIaf/PLDz4E49jZEru+3RwjX9zeHiR/f/iH0W1i/toEg9wKJMPYEYhuC1mB0WL8WAngPzkPXAcidQCKMPaVBqRUEE8iSQJp4tA4oAR+gc0JjFY0V2ha8vw0kwtgRhFI9iMQE0jRQZJ557pjnjtR4ZAWjaRUXleHTZ80lCmtvJyTC2Om0FDAGEhMock9ZOBZFx3LeclS0ZKZDqYDzQmUT/rvIgBTvBe+FrovJ2CuILPXMC8/RrON43rKctSxnDfOsITUdSgKd11Q2AaCyisumP105AZFNOiKMB5yWtkGUhee4bDldWE7mNYvcMssactOitQMCzmuEQJUm5ElGosPqfaLAd/ZDmgSyNDAvHMdly9nC8qKsWBY1RWpJTYtRHSKe8+5d/UG9yo02JNqjVVi/z5UzIow9+GE573hRNpyWNUdFxTxtSEyLVv3p6bv2rwYQJYHtTSTESd9e/VC2HM8sx7Oao6JmljYkukXrjpfl+7eAko9hGZScIwEhgISbYYgw9uaHwlJmNXliexDKcVa+/714U/8E4H7lX26cjO5hEWHs7gdLojuU+CsQrx76tyOMPfhBi+e0/OePe0FIhPF4fjAWrRwvy/e/Aap4U/+46zGYCGFnP7ze17GYCOJ5/BBhPJUfIoxx+SHCuANEnj2PHyYN4y5R55lnXjhOyo6zo4bTJ/TDZGF8jahPFxXLJ/TDJGF8SdSLmeNothH1clYxS2vSzf2lR/XD5GA8RNTmifwwGRh7mMi9eo7jNocMYggTucnCGOJEbpIwhjqRmxSMId3omzSMMfvhoGCM3Q8HA+MQ/DB6GIfkh1HDODQ/jBbGIfphlDAO1Q+jgnHofhgNjCn4YRQwpuKHwcOYkh8GC2OKfhgkjKn6YXAwpuyHQcGYuh8GASP6YSAwoh8GAiP6YSAwoh8GACP6YSAwoh8GAiP6YSAwoh8GAmPIC1EmA2MMC1EmAWMsC1EOHsaYFqIcNIyxLUQ5SBhjXYhycDDiRG4gMOJEbiAw4kRuADDijb6BwIh+GAiM6IeBwIh+GACM6IeBwIh+GFgylAKtexDRD88Eoy/iWJVw3Hji/fE8+uFJYWwnoiw8J4voh2dMRt+KMssdx4uWs6OGs8UmDdEPexpf0flmtIY0DZSF42Terr9/mKc16fqJ956z6IfHT4bRfVnTvHAsZ5ZF3qwTYZTj5eLvt4COfnj8gBiRvsYsM5486ciSjkR1aOX5vnvXyMdwApsn3sfxAABBCAgEuZdGfzUlm3ozEQ8C592fNSBByXn8OHdj4YOwvYVw91PqTQh9dZkP4LzgvMZ5xQf1Olfi6Ys44nhoInwQOm/onKZ1CucF7zc9fddgeL8q9GsVlU2obIIQMNr1lTTbuYpUvkkKgRUMp7m0KZc2oW4VreuB3GqwdL5vVryozKpHDqo0IdEeJatqmjgeCKaH0TrF5aqn76IyWNsn5KrrdV2a2HXQWOHTZw2kVFaRJ1nfmrXqCIqBeGBAAvggOC/UWw2Wtb1dmLhyRt81eonCe+GyUVs9crdTEcF822VrCP0pqXWCtYraCm17OxUbgXvB2tW+lS+CiGMHka/c3CfiNog1jKv/+a4D566+XIoZ2B+Mq022fr7j0vbql7cpRg6PA2QbzF3jf1xTbzokyVW3AAAAAElFTkSuQmCC",
	mrdestructoid : "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",
	speech : "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",
	hourglass : "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",
	};
	
const __bt_ui_emotes =
	{
	billyReady : "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",
	catJam : "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",
	Pepega : "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",
	Hackermans : "R0lGODlhHAAcAPcAABgoEQgUBwAMNlySQCtFHdPT1FWLO3U9KDSINAEuuWpqahlFG0NpLoRFLi5IID5iLIODgjBMIlOFORUiDViRPiMjIiJYJFZlT1qPPjJRJBIRE0lzMv38/SZkJ5SUk0tLS3FwcQE31FRUVAMmlxsbHDg4Nx1MIGs4JUVtL0REREFPOU45IE15NKSkowkjC2NjY6SejqWimQRG/66urTlYJnpAKRlVHTtGNQEBAgETVDtcKA4YCiQ4GWCZQj4iFiczS4raiCZyKAA69alaPBgsVhcsaEBmLLHirJtRNhcrMwoKCjN7NEMlGCwuKzpgJBEvEkE8H2aiRi0WCQEVbTcxGnx7fEl2MA4pEAIIAlQtHjdmN1eJPCg3Z7ZhQEJyMU6CMyI1GCtPGzhVG2SeRTeSOCAyFW7PcQ01EzRZIBs9HCxzMSc9G3VxaWJzWh0vFK1ZPGMzITZXNx5oJT1pJRI5ElCFNFFZTCIqGnOqdCInOGKbRKGfoTI+LVKJOAovDLFePkWUSRo0GyhoLAAFIxU5GS18LFO2VUCKQ4tKLz1nLBUwF0FHW6FTOGCXQhI0EaNYOAA//0FlJBEeDmOaOwRI/yBfIgkcCg8ODxFFFzZVJURqJRg9Fm9ucAFD/z2cPgRA+QYOBSIyDAMEBXFtZwQLBgAejhYVIU99NhZeGrNgP1ydYS9tLlqNWjJdJipbLRwMA4bEiFGdUnl4dhgYGFyaQqtcPD4eCqmlqQYGBkBiRBRBFAUBA1B6KQRB80xLQlqWPlqLMmGeQQ0/D2xobixLLaimphwoAy4sMTqjP6mpqRNRFiA4GF6VQBYWFhMfGCxiLK9ePl6XQq1cPF6VQqtYO1qTP1yPPqlWOl6XQKFQNlaNOXZ1dgRE+61ePm52alyVPkdHR3R8cFFNQgE56K2nl2xoYp6bnVeGMQNC+j09PxUUFU9PTkRmGFwvHqpXMSNBEh4eIU16TkJuKjMzM5BOMj5wP0Z4NDp/PV5eXgRD/6ZaOwAAAGZmZlqNPgAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh/wtYTVAgRGF0YVhNUDw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuMy1jMDExIDY2LjE0NTY2MSwgMjAxMi8wMi8wNi0xNDo1NjoyNyAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wTU09Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9tbS8iIHhtbG5zOnN0UmVmPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VSZWYjIiB4bWxuczp4bXA9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC8iIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDoyMjNDQUYwRUQ4ODZFODExQTlBRDk0NUNCQUQxN0Q1MCIgeG1wTU06RG9jdW1lbnRJRD0ieG1wLmRpZDowN0RCOEE1Mzg2REQxMUU4ODJFM0RFQjUyQUFFQUNFMSIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDowN0RCOEE1Mjg2REQxMUU4ODJFM0RFQjUyQUFFQUNFMSIgeG1wOkNyZWF0b3JUb29sPSJBZG9iZSBQaG90b3Nob3AgQ1M2IChXaW5kb3dzKSI+IDx4bXBNTTpEZXJpdmVkRnJvbSBzdFJlZjppbnN0YW5jZUlEPSJ4bXAuaWlkOjIyM0NBRjBFRDg4NkU4MTFBOUFEOTQ1Q0JBRDE3RDUwIiBzdFJlZjpkb2N1bWVudElEPSJ4bXAuZGlkOjIyM0NBRjBFRDg4NkU4MTFBOUFEOTQ1Q0JBRDE3RDUwIi8+IDwvcmRmOkRlc2NyaXB0aW9uPiA8L3JkZjpSREY+IDwveDp4bXBtZXRhPiA8P3hwYWNrZXQgZW5kPSJyIj8+Af/+/fz7+vn49/b19PPy8fDv7u3s6+rp6Ofm5eTj4uHg397d3Nva2djX1tXU09LR0M/OzczLysnIx8bFxMPCwcC/vr28u7q5uLe2tbSzsrGwr66trKuqqainpqWko6KhoJ+enZybmpmYl5aVlJOSkZCPjo2Mi4qJiIeGhYSDgoGAf359fHt6eXh3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"
	};

bt_main();