export function composerState(state:{signedIn:boolean;selected:boolean;loading:boolean;busy:boolean;full:boolean;ready:boolean;settingsLoaded:boolean;settingsError:string;hasText:boolean}) {
 const inputDisabled=!state.signedIn||state.selected||state.loading||state.busy||state.full;
 const reason=!state.signedIn?'로그인하면 AI와 대화할 수 있습니다.':state.loading?'저장된 대화를 불러오는 중입니다.':state.selected?'저장된 버전을 보고 있습니다. 문답에서 이어 쓰기를 선택하거나 새 주제를 만드세요.':state.busy?'답변을 처리하는 중입니다.':state.full?'이 대화의 길이 제한에 도달했습니다. 새 주제로 이어가세요.':state.settingsError?'AI 설정을 불러오지 못했습니다. 입력한 글은 유지됩니다. 다시 연결해 주세요.':!state.settingsLoaded?'AI 연결을 확인하는 중입니다. 먼저 내용을 입력해도 됩니다.':!state.ready?'선택한 AI를 사용할 수 없습니다. 다른 AI를 선택하거나 설정에서 연결해 주세요.':'';
 return {inputDisabled,sendDisabled:inputDisabled||!state.ready||!state.hasText,reason};
}
