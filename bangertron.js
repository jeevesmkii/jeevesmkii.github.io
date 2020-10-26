
function bangertron_iframe_load(ev)
	{
	alert("iframe loaded");
	}

function init_bangers()
	{
	document.body.innerHTML = "";
	document.getElementsByTagName('head')[0].innerHTML = "";
	
	var ifrm = document.createElement("iframe");
	ifrm.setAttribute("src", "https://www.youtube.com/embed/pRpeEdMmmQ0");
	ifrm.setAttribute("autoplay", "0");
	ifrm.style.width = "560x";
	ifrm.style.height = "315px";
	ifrm.addEventListener("load", bangertron_iframe_load);
	//ifrm.style.display = "none";
	document.body.appendChild(ifrm);
	}

alert("hello, world!");
init_bangers();


// javascript:(function(){ 
//	var script = document.createElement('script'); 
//	script.src = "http://localhost:8080/bangertron,js";
//	document.getElementsByTagName('head')[0].appendChild(script);
//})();