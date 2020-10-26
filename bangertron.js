
function init_bangers()
	{
	document.body.innerHTML = "";
	document.getElementsByTagName('head')[0].innerHTML = "";
	
	var ifrm = document.createElement("iframe");
	ifrm.setAttribute("src", "https://www.youtube.com/watch?v=pRpeEdMmmQ0");
	ifrm.style.width = "640px";
	ifrm.style.height = "480px";
	document.body.appendChild(ifrm);
	}

alert("hello, world!");
init_bangers();


// javascript:(function(){ 
//	var script = document.createElement('script'); 
//	script.src = "http://localhost:8080/bangertron,js";
//	document.getElementsByTagName('head')[0].appendChild(script);
//})();