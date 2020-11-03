var _bt_known_ciphers = {};
var _bt_media = {};

var _bt_await = 
	{
	ciphers : {},
	media : {}
	};

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
		pattern = pattern.replace(/\$[a-z][a-z0-9]*/isg, 
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
		.then(response => response.text())
		.then(txt => callback(txt))
		.catch(err => console.log("Error: " + err));
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
		bt_fetch_url("https://www.youtube.com/s/player/" + cipher_base + ".js",
			bt_curry(bt_find_cipher_spec)(cipher_base));
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
		throw "bt_get_cipher: failed to find cipher function name.";
	
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
		throw "bt_get_cipher: failed to find cipher function body.";
	
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
					throw "bt_get_cipher: called function in cipher spec not found in player js.";
				
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
					throw "bt_get_cipher: can't interpret called function in cipher spec.";
					}	
				}
			else
				{
				throw "bt_get_cipher: unparseable statement in cipher function.";
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
				sig = sig.substr(m[1]);
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

function bt_prune_media()
	{
	var time = Date.now() / 1000;
	Object.keys(_bt_media).forEach(
		key => _bt_media[key] = _bt_media[key].filter(
			fmt =>
				{
				return fmt.expires > time;
				})
			);
	}

function bt_get_fmts(id)
	{
	bt_prune_media();
	
	var fmts;
	if (id in _bt_media)
		fmts = _bt_media[id];
	return fmts;
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
			processed_fmts.push(fmt);
			}
		}
	
	bt_prune_media();
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
		bt_fetch_url("https://www.youtube.com/watch?v=" + id,
			bt_curry(bt_find_fmts)(id));
		return;
		}
	
	var cfg = "";
	var cipher_base = bt_get_cipher_base(html);
	
	if (cfg = html.match(/ytplayer\.config\s*=\s*({.*?});/s))
		cfg = cfg[1];
	else
		throw "get_fmts: no youtube player config structure.";
	
	cfg = JSON.parse(cfg);
	if (!"args" in cfg || !"player_response" in cfg.args)
		throw "get_fmts: missing expected JSON structure in player config.";
		
	cfg = JSON.parse(cfg.args.player_response);
	if (!"streamingData" in cfg)
		throw "get_fmts: no streamingData in player config.";
	
	if (!"expiresInSeconds" in cfg.streamingData)
		throw "get_fmts: no expiry time in streaming data.";
	
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
					fmt.loudness = loudness;
					fmt.perceptual_loudness = pLoudness;
					fmt.cipher_base = cipher_base;
					fmt.expires = expires;
					fmts.push(fmt);
					}
				});
		}
	
	bt_postprocess_fmts(id, fmts);
	}

function bt_dotest()
	{
	document.body.innerHTML = "";
	document.getElementsByTagName('head')[0].innerHTML = "";
	
	var id = "pRpeEdMmmQ0";
	var frm = document.createElement("form");
	frm.name = "outputform";
	
	var txt = document.createElement("textarea");
	txt.name = "outputbox";
	txt.id = "outputbox";
	txt.rows = 20;
	txt.cols = 80;
	
	frm.appendChild(txt);
	document.body.appendChild(frm);
	
	bt_await_fmts(id, function() {
		var fmts = bt_get_fmts(id);
		txt.value = JSON.stringify(fmts);
	});
	bt_find_fmts(id);
	}
	

bt_dotest();

// javascript:(function(){ 
//	var script = document.createElement('script'); 
//	script.src = "http://localhost:8080/bangertron,js";
//	document.getElementsByTagName('head')[0].appendChild(script);
//})();