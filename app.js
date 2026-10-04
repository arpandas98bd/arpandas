(function(){
var N=[["index","Home"],["education","Education"],["publications","Publications"],["lab-experience","Lab Experience"],["skills","Skills"],["cv","CV"],["extra-curricular","Extra-Curricular"],["photography","Photography"],["blog","Blog"],["data-analysis","Data Analysis"],["contact","Contact"]];
var P=window.PAGE,$=function(s){return document.querySelector(s)};
function h(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.innerHTML=x;return e}
try{var t0=localStorage.getItem("theme");if(t0)document.documentElement.dataset.theme=t0}catch(e){}
$("nav").innerHTML="<b>Arpan Das</b>"+N.map(function(n){return'<a href="'+n[0]+'.html"'+(n[0]===P.id?' class="on"':"")+">"+n[1]+"</a>"}).join("")+'<button class="ib" id="th">Theme</button>';
$("#th").onclick=function(){var d=document.documentElement,v=d.dataset.theme==="dark"?"light":"dark";d.dataset.theme=v;try{localStorage.setItem("theme",v)}catch(e){}};
var m=$("main"),ix=N.findIndex(function(n){return n[0]===P.id}),pv=N[ix-1],nx=N[ix+1];
$("footer").insertAdjacentHTML("beforebegin",'<div class="pn"><span>'+(pv?'<a href="'+pv[0]+'.html">&larr; '+pv[1]+"</a>":"")+"</span><span>"+(nx?'<a href="'+nx[0]+'.html">'+nx[1]+" &rarr;</a>":"")+"</span></div>");
$("footer").innerHTML="&copy; "+new Date().getFullYear()+" Arpan Das";
document.title=P.title+" | Arpan Das";
if(P.type!=="home")m.innerHTML="<h1>"+P.title+'</h1><p class="sub">'+P.sub+"</p>";
var T={
list:function(){var I=P.items;if(!I.length){m.appendChild(h("p","emp",P.empty));return}
 var n=I.length,cur=-1,cards=[],sc,fl,dots=[];
 function go(i,s){cur=i;dots.forEach(function(b,j){b.classList.toggle("on",j===i);b.classList.toggle("past",j<=i)});if(fl)fl.style.width=(i<0?0:i/(n-1)*100)+"%";
  cards.forEach(function(c,j){c.classList.toggle("on",j===i);c.firstChild.setAttribute("aria-expanded",j===i)});
  [].forEach.call(m.querySelectorAll(".r"),function(r){r.classList.toggle("on",+r.dataset.i===i)});
  if(s&&i>=0){if(cards[i].hidden)fs.firstChild.click();setTimeout(function(){cards[i].scrollIntoView({behavior:"smooth",block:"nearest"})},120)}}
 if(P.scrub){sc=h("div","sc");sc.appendChild(h("div","tr"));fl=h("div","fl");sc.appendChild(fl);
  I.forEach(function(e,i){var b=h("button","", "<i></i><b>"+e.yr+"</b>"+e.city);b.style.left=(i/(n-1)*100)+"%";b.onclick=function(){go(i,1)};dots.push(b);sc.appendChild(b)});
  m.appendChild(sc);var nv=h("div","row");[["Previous",-1],["Next",1]].forEach(function(x){var b=h("button","ib",x[0]);b.onclick=function(){go(Math.max(0,Math.min(n-1,cur+x[1])),1)};nv.appendChild(b)});m.appendChild(nv);
  var sI=I.filter(function(e){return e.sc});if(sI.length){m.appendChild(h("h2","","Academic record"));var rg=h("div","rg");
   sI.slice().reverse().forEach(function(e){var i=I.indexOf(e),o=(188*(1-e.sc/e.mx)).toFixed(1),b=h("button","r",'<div class="ring" style="--o:'+o+'"><svg width="70" height="70" viewBox="0 0 70 70"><circle class="b" cx="35" cy="35" r="30"/><circle class="v" cx="35" cy="35" r="30"/></svg><span>'+e.sc+"</span></div><div><strong>"+e.lab+" "+e.sc+" / "+e.mx+"</strong><small>"+e.t.split(" (")[0]+"</small></div>");b.dataset.i=i;b.onclick=function(){go(i,1)};rg.appendChild(b)});
   m.appendChild(rg);new IntersectionObserver(function(es,o){if(es[0].isIntersecting){rg.classList.add("go");o.disconnect()}},{threshold:.3}).observe(rg)}
  m.appendChild(h("h2","","Details"))}
 var tags=["All"];I.forEach(function(e){if(e.tag&&tags.indexOf(e.tag)<0)tags.push(e.tag)});
 var fs=h("div","row");if(tags.length>2)tags.forEach(function(f,i){var b=h("button","ib"+(i?"":" on"),f);b.onclick=function(){[].forEach.call(fs.children,function(x){x.classList.remove("on")});b.classList.add("on");cards.forEach(function(c,j){c.hidden=f!=="All"&&I[j].tag!==f})};fs.appendChild(b)});
 m.appendChild(fs);var ls=h("div");
 (P.scrub?I.map(function(_,i){return i}).reverse():I.map(function(_,i){return i})).forEach(function(i){var e=I[i],rows=(e.rows||[]).slice();if(e.link)rows.push(["Link",'<a href="'+e.link+'" target="_blank" rel="noopener">Open</a>']);
  var c=h("article","cd",'<button aria-expanded="false"><span><h3>'+e.t+(e.tag?'<span class="tg">'+e.tag+"</span>":"")+'</h3><span class="m">'+e.s+'</span></span><svg class="ch" width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7l6 6 6-6"/></svg></button><div class="bd"><div><dl class="dl">'+rows.map(function(r){return"<dt>"+r[0]+"</dt><dd>"+r[1]+"</dd>"}).join("")+"</dl></div></div>");
  c.firstChild.onclick=function(){go(cur===i?-1:i,0)};cards[i]=c;ls.appendChild(c)});
 m.appendChild(ls);if(P.scrub)go(n-1,0)},
skills:function(){var G=P.groups,cats=["All"].concat(Object.keys(G)),fs=h("div","row"),sk=h("div","sk");
 function show(f){sk.innerHTML="";Object.keys(G).forEach(function(c){if(f==="All"||f===c)G[c].forEach(function(s){sk.appendChild(h("span","",s+"<small>"+c+"</small>"))})})}
 cats.forEach(function(f,i){var b=h("button","ib"+(i?"":" on"),f);b.onclick=function(){[].forEach.call(fs.children,function(x){x.classList.remove("on")});b.classList.add("on");show(f)};fs.appendChild(b)});
 m.appendChild(fs);m.appendChild(sk);show("All");if(P.langs)m.appendChild(h("p","sub","<br>Languages: "+P.langs))},
gallery:function(){if(!P.photos.length){m.appendChild(h("p","emp",P.empty));return}
 var g=h("div","gal"),lb=h("div","","<img alt=''><div></div>");lb.id="lb";
 P.photos.forEach(function(p){var b=h("button","",'<img loading="lazy" alt="'+p.cap+'" src="images/'+p.src+'">');b.onclick=function(){lb.firstChild.src="images/"+p.src;lb.lastChild.textContent=p.cap;lb.classList.add("on")};g.appendChild(b)});
 lb.onclick=function(){lb.classList.remove("on")};addEventListener("keydown",function(e){if(e.key==="Escape")lb.classList.remove("on")});m.appendChild(g);document.body.appendChild(lb)},
cv:function(){m.appendChild(h("div","row",'<a class="btn p" href="cv.pdf" download>Download CV (PDF)</a><a class="btn" href="cv.pdf" target="_blank">Open in new tab</a>'));m.appendChild(h("iframe","","")).src="cv.pdf"},
contact:function(){var L=P.links;
 m.appendChild(h("div","row",'<a class="btn p" href="mailto:'+L.email+'">Email me</a><button class="btn" id="cp">Copy email</button>'+["LinkedIn","Instagram","Facebook"].map(function(k){return'<a class="btn" target="_blank" rel="noopener" href="'+L[k.toLowerCase()]+'">'+k+"</a>"}).join("")));
 $("#cp").onclick=function(){var b=this;(navigator.clipboard?navigator.clipboard.writeText(L.email):Promise.reject()).then(function(){b.textContent="Copied"},function(){b.textContent=L.email})};
 m.appendChild(h("h2","","Send a message"));var f=h("form","",'<input id="fn" placeholder="Your name" required><textarea id="fm" rows="5" placeholder="Message" required></textarea><button class="btn p" style="border:0">Open in my email app</button>');
 f.onsubmit=function(e){e.preventDefault();location.href="mailto:"+L.email+"?subject="+encodeURIComponent("Message from "+$("#fn").value)+"&body="+encodeURIComponent($("#fm").value)};m.appendChild(f)},
home:function(){
 m.style.padding="0";m.style.maxWidth="none";
 m.innerHTML='<header class="hero"><canvas id="cv" aria-hidden="true"></canvas><div class="hc"><h1>'+P.name+'</h1><div class="role">'+P.role+'</div><p class="tag">'+P.tag+'</p><div class="row"><a class="btn p" href="cv.html">View CV</a><a class="btn" href="contact.html">Contact</a></div></div></header><div style="max-width:860px;margin:0 auto;padding:30px 20px"><div class="stats">'+P.stats.map(function(s){return'<div class="st"><b>'+s[0]+"</b><span>"+s[1]+"</span></div>"}).join("")+"</div><h2>Explore</h2><div class=tiles>"+N.slice(1).map(function(n){return'<a class="tile" href="'+n[0]+'.html"><b>'+n[1]+"</b><span>"+(P.tiles[n[0]]||"")+"</span></a>"}).join("")+"</div></div>";
 var cv=$("#cv"),cx=cv.getContext("2d"),hero=$(".hero"),W,H,tips=[],mx=null,my=null,segs=0,MAX=5000;
 var col=function(){return getComputedStyle(document.documentElement).getPropertyValue("--ac").trim()};
 function seed(x,y,a){tips.push({x:x,y:y,a:a,w:2.4,l:60+Math.random()*90})}
 function reset(){var r=hero.getBoundingClientRect(),d=devicePixelRatio||1;W=r.width;H=r.height;cv.width=W*d;cv.height=H*d;cx.setTransform(d,0,0,d,0,0);tips=[];segs=0;for(var i=0;i<5;i++)seed(W*(.15+.17*i),0,Math.PI/2)}
 function step(){var nx=[];tips.forEach(function(t){var w=Math.PI/2;if(mx!=null){var dx=mx-t.x,dy=my-t.y;if(dx*dx+dy*dy<80000)w=Math.atan2(dy,dx)}
  t.a+=Math.atan2(Math.sin(w-t.a),Math.cos(w-t.a))*.07+(Math.random()-.5)*.35;var x=t.x+Math.cos(t.a)*3,y=t.y+Math.sin(t.a)*3;
  cx.strokeStyle=col();cx.globalAlpha=Math.min(1,.3+t.w/3);cx.lineWidth=t.w;cx.lineCap="round";cx.beginPath();cx.moveTo(t.x,t.y);cx.lineTo(x,y);cx.stroke();
  t.x=x;t.y=y;t.l--;t.w*=.994;segs++;if(t.l>0&&y<H+10&&t.w>.3){nx.push(t);if(Math.random()<.02&&nx.length<140)nx.push({x:x,y:y,a:t.a+(Math.random()<.5?-1:1)*(.7+Math.random()*.5),w:t.w*.7,l:40+Math.random()*60})}});
  cx.globalAlpha=1;tips=nx;if(tips.length<3&&segs<MAX)seed(Math.random()*W,0,Math.PI/2)}
 addEventListener("pointermove",function(e){var r=hero.getBoundingClientRect();if(e.clientY<r.top||e.clientY>r.bottom){mx=null;return}mx=e.clientX-r.left;my=e.clientY-r.top;if(tips.length<50&&segs<MAX&&Math.random()<.25)seed(mx,my,Math.PI/2+(Math.random()-.5))});
 hero.addEventListener("click",function(e){if(e.target.closest("a"))return;var r=hero.getBoundingClientRect();for(var i=0;i<4;i++)seed(e.clientX-r.left,e.clientY-r.top,Math.PI/2+(Math.random()-.5)*1.6);segs=Math.min(segs,MAX-1200)});
 addEventListener("resize",reset);reset();$("#th").addEventListener("click",reset);
 if(matchMedia("(prefers-reduced-motion:reduce)").matches){for(var i=0;i<500;i++)step()}else(function f(){if(segs<MAX||tips.length)step();requestAnimationFrame(f)})()}
};
T[P.type]();
})();