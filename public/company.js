const COMPANY_INFO={
 openai:{name:'OpenAI',desc:'ChatGPT、GPT、Codex、研究、安全性、企業導入、独自インフラなどOpenAI関連ニュース。'},
 google:{name:'Google / DeepMind',desc:'Gemini、Google DeepMind、Gemma、ロボティクス、科学研究、安全性などGoogleのAI関連ニュース。'},
 anthropic:{name:'Anthropic',desc:'Claude、エージェント、研究、安全性、企業導入などAnthropic関連ニュース。'},
 nvidia:{name:'NVIDIA',desc:'GPU、CUDA、Blackwell、Rubin、AIデータセンターなどNVIDIA関連ニュース。'},
 meta:{name:'Meta',desc:'Llama、Meta AI、研究、製品、安全性、インフラなどMeta関連ニュース。'},
 microsoft:{name:'Microsoft',desc:'Copilot、Azure AI、OpenAI連携、企業導入、インフラなどMicrosoft関連ニュース。'},
 xai:{name:'xAI',desc:'Grok、モデル、研究、製品、インフラなどxAI関連ニュース。'},
 amazon:{name:'Amazon / AWS',desc:'AWS、Bedrock、クラウドAI、企業導入、インフラなどAmazon関連ニュース。'}
};
let rows=[];const key=companyFromQuery();const info=COMPANY_INFO[key]||null;
function showInvalidCompany(){document.title='企業が見つかりません — AI BRIEF Ultra';const title=$('#companyTitle'),desc=$('#companyDesc'),badge=$('#companyBadge'),grid=$('#newsGrid');if(title)title.textContent='企業が見つかりません';if(desc)desc.textContent='URLのcompany指定が不正、または未対応です。トップページから企業を選び直してください。';if(badge)badge.textContent='INVALID COMPANY';if(grid)grid.innerHTML='<div class="errorbox"><strong>企業指定が不正です</strong><a href="index.html">トップページへ戻る</a></div>'}
if(info){document.title=`${info.name} 最新AIニュース — AI BRIEF Ultra`;$('#companyTitle').textContent=info.name;$('#companyDesc').textContent=info.desc;$$('#navLinks a').forEach(a=>{if(a.getAttribute('href')===`${key}.html`)a.classList.add('active')})}else showInvalidCompany();
function render(){if(!info)return;const q=($('#searchInput')?.value||'').trim().toLowerCase();let show=rows.filter(a=>!q||`${a.title||''} ${a.summary||''} ${a.source||''}`.toLowerCase().includes(q));if($('#sortSelect')?.value==='source')show.sort((a,b)=>String(a.source||'').localeCompare(String(b.source||''),'ja')||new Date(b.publishedAt||0)-new Date(a.publishedAt||0));else show.sort((a,b)=>new Date(b.publishedAt||0)-new Date(a.publishedAt||0));$('#resultCount').textContent=`${show.length}件`;$('#newsGrid').innerHTML=show.length?show.map(cardHTML).join(''):'<div class="empty">現在、この企業に一致するニュースがありません。</div>'}
async function init(){if(!info)return;const grid=$('#newsGrid');grid.innerHTML=skeletons(6);try{const data=await api(`/api/news?company=${encodeURIComponent(key)}&limit=180`);rows=Array.isArray(data.items)?data.items:[];updateGlobalStatus(data.meta);$('#companyBadge').textContent=`${modeLabel(data.meta?.mode)} · ${data.total??rows.length} ARTICLES`;render()}catch(e){grid.innerHTML='<div class="errorbox"><strong>取得に失敗しました</strong>サーバーまたはオフラインキャッシュを確認してください。</div>'}}
$('#searchInput')?.addEventListener('input',render);$('#sortSelect')?.addEventListener('change',render);init();
