/* ---- boot ---- */
$('#brandmark').innerHTML=ic('zap');
$('#drawerClose').innerHTML=ic('x');
(function(){const dw=$('#drawer');dw.addEventListener('click',e=>{if(e.target===dw||e.target.closest('#drawerClose'))closeDrawer();});})();
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('#drawer').classList.contains('show'))closeDrawer();if(e.key==='Escape'&&S.resultFullscreen)setResultFullscreen(false);});
initProfiles();render();
initUpdateCheck();
