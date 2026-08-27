const COMPANY_INFO={
 openai:{name:'OpenAI',desc:'ChatGPT、GPT、Codex、研究、安全性、企業導入、独自インフラなどOpenAI関連ニュース。'},
 google:{name:'Google / DeepMind',desc:'Gemini、Google DeepMind、Gemma、ロボティクス、科学研究、安全性などGoogleのAI関連ニュース。'},
 anthropic:{name:'Anthropic',desc:'Claude、エージェント、研究、安全性、企業導入などAnthropic関連ニュース。'}
};
let rows=[];const key=companyFromQuery();const info=COMPANY_INFO[key]||COMPANY_INFO.openai;
document.title=`${info.name} 最新AIニュース — AI BRIEF Ultra`;$('#companyTitle').textContent=info.name;$('#companyDesc').textContent=info.desc;
$$('#navLinks a').forEach(a=>{if(a.getAttribute('href')===`${key}.html`)a.classList.add('active')});
function render(){const q=$('#searchInput').value.trim().toLowerCase();let show=rows.filter(a=>!q||`${a.title} ${a.summary} ${a.source}`.toLowerCase().includes(q));if($('#sortSelect').value==='source')show.sort((a,b)=>a.source.localeCompare(b.source,'ja'));else show.sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));$('#resultCount').textContent=`${show.length}件`;$('#newsGrid').innerHTML=show.length?show.map(cardHTML).join(''):'<div class="empty">現在、この企業に一致するニュースがありません。</div>'}
async function init(){const grid=$('#newsGrid');grid.innerHTML=skeletons(6);try{const data=await api(`/api/news?company=${encodeURIComponent(key)}&limit=80`);rows=data.items;updateGlobalStatus(data.meta);$('#companyBadge').textContent=`${modeLabel(data.meta.mode)} · ${data.total} ARTICLES`;render()}catch(e){grid.innerHTML='<div class="errorbox"><strong>取得に失敗しました</strong>サーバーが起動しているか確認してください。</div>'}}
$('#searchInput').addEventListener('input',render);$('#sortSelect').addEventListener('change',render);init();
