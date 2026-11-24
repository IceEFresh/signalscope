//collect values
var urlParams;
(window.onpopstate = function () {
    var match,
        pl     = /\+/g,  // Regex for replacing addition symbol with a space
        search = /([^&=]+)=?([^&]*)/g,
        decode = function (s) { return decodeURIComponent(s.replace(pl, " ")); },
        query  = window.location.search.substring(1);

    urlParams = {};
    while (match = search.exec(query))
       urlParams[decode(match[1])] = decode(match[2]);
})();

function searchadvisories() {
	var yr = document.forms[0].Year.value;
	var statute = document.forms[0].Statute.value;
//	var qry = document.forms[0].Terms.value; //required
	var ViewNameURL = 'Legal+Advisories+HTML?SearchView'
	var DbPathURL = window.location.toString().substring(0, window.location.toString().indexOf(".gov") + 4);
	DbPathURL = DbPathURL + "/preview/oge.nsf/";
	//	var DbPathURL = window.location.toString().substring(0, window.location.toString().indexOf(".nsf/") + 5);
		var QueryURL = ''
		var QueryValue = $F('Terms'); //required
		var x=0
if (QueryValue + statute == '')
	{		var searchURL ="&Query="
	}
else if (QueryValue == '')
		{
		var searchURL ="&Query=" + statute
		}
else if (statute == '')
{
var searchURL ="&Query=" + QueryValue
}

else
		{
		var EncodedQueryValue = escape(QueryValue); //replace special characters
		var searchURL ="&Query=" + EncodedQueryValue + "+AND+" + statute
		}
// *************************************************************
	if (yr == "")
	{
	var yrURL = ''
		var so = '&searchorder=3'
	}
	else
	{
	var so=''
	var beginyr = '[DocumentDate]>12/31/' + (yr-1);
	var endyr = '[DocumentDate]<1/1/' + (+yr + +1);
	var yrURL = '+AND+' + beginyr + '+AND+' + endyr
	}
	srchURL = DbPathURL + ViewNameURL + searchURL + yrURL + so;
	srchURL = srchURL.replace(/ /g,'+');
	window.location.href = srchURL;
	//  
}


function searchall()
{
	var vn = document.getElementById('view').innerHTML;
	var so = '&searchorder=3'
	//	var scope = document.getElementById('scope').innerHTML;
	var scp = document.getElementsByName('scope');
	var searchscope = "";
	for (var i=0, n=scp.length;i<n;i++) 
	{
	  if (scp[i].checked) 
	  	{
		  searchscope = scp[i].value;
	    }
	}
	
	// *******************************************************
	var ViewNameValue = "";
	if (vn == "" || vn == "OGE" || vn == "Resources" || searchscope == "all OGE")
		{ViewNameValue = 'All+Documents';}
	else {				
		ViewNameValue = vn;}
	if (urlParams["RestrictToCategory"] != undefined)
	{alert("Your search will include all documents under " + ViewNameValue + "\nNot just those categorized as " + urlParams["RestrictToCategory"])+ " use the Advanced search to add additional criteria.";}
//	alert(ViewNameValue);
	var ViewNameURL = ViewNameValue + '?SearchView';
	var dViewNameURL = ViewNameURL.replace(/ /g,'+');
	var DbPathURL = window.location.toString().substring(0, window.location.toString().indexOf(".gov") + 4);
	DbPathURL = DbPathURL + "/web/oge.nsf";
	var QueryValue = document.forms[0].Query.value; //required
	if (QueryValue == "") 
	{return false}
	var QueryValueWithSpaces = QueryValue.replace(/ /g,'+'); //replace spaces with pluses
	var EncodedQueryValue = escape(QueryValueWithSpaces); //replace special characters if any
	var QueryURL = '&Query=' + EncodedQueryValue;
	var SearchMaxResultsURL = '&SearchMax=0'; //Required for our form, optional in Domino.
	var sw = DbPathURL + '/' +  ViewNameURL + QueryURL  + SearchMaxResultsURL + so
	window.location.href = sw

}
// ****************************************************************************

// ****************************************************************************

function searchview()
{
	var vn = document.getElementById("sv").innerHTML;
	var ViewNameURL = ViewName + '?SearchView';
	var dViewNameURL = ViewNameURL.replace(/ /g,'+');
	var DbPathURL = window.location.toString().substring(0, window.location.toString().indexOf(".gov") + 4);
	DbPathURL = DbPathURL + "/web/oge.nsf";
	var QueryValue = document.forms[0].Query.value; //required
	if (QueryValue == "") 
	{return false}
	var QueryValueWithSpaces = QueryValue.replace(/ /g,'+'); //replace spaces with pluses
	var EncodedQueryValue = escape(QueryValueWithSpaces); //replace special characters if any
	var QueryURL = '&Query=' + EncodedQueryValue;
	var SearchMaxResultsURL = '&SearchMax=0'; //Required for our form, optional in Domino.
	var sw = DbPathURL +  dViewNameURL + QueryURL  + SearchMaxResultsURL
	window.location.href = sw

}
function urlsearch()
{
	var text = document.getElementById("qry").value;
	    var sel;
	    if (window.find && window.getSelection) {
	        sel = window.getSelection();
	        if (sel.rangeCount > 0) {
	            sel.collapseToEnd();
	        }
	        window.find(text);
	    } else if (document.selection && document.body.createTextRange) {
	        sel = document.selection;
	        var textRange;
	        if (sel.type == "Text") {
	            textRange = sel.createRange();
	            textRange.collapse(false);
	        } else {
	            textRange = document.body.createTextRange();
	            textRange.collapse(true);
	        }
	        if (textRange.findText(text)) {
	            textRange.select();
	        }
	   
	}
	
}


function quicksearch()
{
	
	var QueryValue = document.getElementById("qry").innerHTML;
	var u = window.location.href;
	var burl = window.location.toString().substring(0, window.location.toString().indexOf(".nsf/") + 5);
	var burl = window.location.toString().substring(0, window.location.toString().indexOf(".gov") + 4);
	burl = burl + "/web/oge.nsf/";

	var uv = burl.toLowerCase();
	var v = document.getElementById("view").innerHTML;
	if (uv  == 'http'){
		v= u + '/' + v;
		uv='';
}
	var tuv = uv + v + "?searchview";
	var QueryValue = document.getElementById("qry").value; //required
	if (QueryValue == "") 
	{return false}
	var QueryValueWithSpaces = QueryValue.replace(/ /g,'+'); //replace spaces with pluses
	var EncodedQueryValue = escape(QueryValueWithSpaces); //replace special characters if any
	var QueryURL = '&Query=' + EncodedQueryValue;
	var SearchMaxResultsURL = '&SearchMax=0'; //Required for our form, optional in Domino.
	var sw = tuv + QueryURL  + SearchMaxResultsURL;
	window.location.href = sw

}


//collect values
function dosearch()
{
var ViewNameURL = 'All+Documents?SearchView'
var DbPathURL = window.location.toString().substring(0, window.location.toString().indexOf(".gov") + 4);
DbPathURL = DbPathURL + "/web/oge.nsf/";
var QueryURL = ''
var QueryValue = $F('qry'); //required
var x=0

if (QueryValue == '')
{
var searchURL ="&Query="
}
else
{
var EncodedQueryValue = escape(QueryValue); //replace special characters
var searchURL = "&Query=" + EncodedQueryValue;
}
//  *************************************************
	var checkboxes = document.getElementsByName('Category');
	var vals = "";
	var j=0;
	for (var i=0, n=checkboxes.length;i<n;i++) 
	{
	  if (checkboxes[i].checked) 
	  	{
		  if(j==0)
			  {
			  vals = "[Category]=" +checkboxes[i].value; 
			  j=1;
			  }
		  else
		  	  {
			  vals = vals + "+OR+[Category]=" +checkboxes[i].value; 
			  }
		  vals == "(" +vals + ")";
	    }
	}
	if (searchURL == '&Query=')
	 	{
		searchURL = searchURL + vals ;
	 	}
	else
		{
		if (vals!=="")
			{
			searchURL = searchURL + '+AND+' + "(" + vals + ")";
			}
		}
	// ******************************************************************
	var TitleURL = ''
		var TitleValue = $F('Title')
		if (TitleValue == "")
		 {
		TitleURL = ''
		} 
		else
		{
		var EncodedTitleValue = escape(TitleValue); //replace special characters
		if (searchURL == '&Query=')
			{
			searchURL = searchURL+ '[Title]=' + EncodedTitleValue;
			}
		else
			{
			searchURL = searchURL + '+AND+[Title]=' + EncodedTitleValue;
			}
		}

	//CREATEDATE: test for 2 values - From and To. if one then get operator or default to > 
	var FromValue = $F('From')
	var EncodedFromValue = escape(FromValue); //replace special characters
	
	var ToURL = ''
	var ToValue = $F('To')
	var EncodedToValue = escape(ToValue); //replace special characters
	var op = $F('FromOperator')
	var cd = EncodedFromValue.concat(EncodedToValue);
	var n = cd.length;
	if (n > 0)
	{
		if (EncodedFromValue == "" || EncodedToValue == "" )
		// doing single with operator
			{
				var dtval = op + EncodedFromValue.concat(EncodedToValue)
				if (searchURL == '&Query=')
				{
					searchURL = searchURL+ '[DocumentDate]' + dtval;
				}
				else
				{
					searchURL = searchURL + '+AND+[DocumentDate]' + dtval;
				}	
			}
		else
			//got a date range
			{
				if (searchURL == '&Query=')
				{
					searchURL = searchURL + '[DocumentDate]>' + EncodedFromValue + '+AND+' + '[DocumentDate]<' + EncodedToValue;
				}
				else
				{
					searchURL = searchURL+ '+AND+[DocumentDate]>' + EncodedFromValue + '+AND+'+'[DocumentDate]<' + EncodedToValue;
				}	
			}
	}
// **************************************************************************************
	var SearchOrderValue = $F('SearchOrder');  //Optional. 1 is Domino Default, therefore returning blank string if  not checked
// alert(SearchOrderValue);
	if (SearchOrderValue == 1)
		{
		var SearchOrderURL = ''
		}
	else
		{
		var SearchOrderURL = '&SearchOrder=' + SearchOrderValue
		var optionsURL = '&SearchMax=0&SearchWV=TRUE' + SearchOrderURL;
		}

searchURL = DbPathURL + ViewNameURL + searchURL + SearchOrderURL;

var res = searchURL.replace("&","+AND+");
res = res.replace("+AND+Query","&Query");
window.location.href = res;
}
//**********************************************************************************************************************************
//collect values
function dosearch1()
{
	//this searches interactions only
var ViewNameURL = 'Interactions+Search?SearchView'
var DbPathURL = window.location.toString().substring(0, window.location.toString().indexOf(".gov") + 4);
DbPathURL = DbPathURL + "/web/oge.nsf";
var QueryURL = ''
var QueryValue = document.forms[0].Query.value;
var x=0

//var qv = QueryValue.replace("(",'');
//QueryValue = qv.replace(")",'');
if (QueryValue == '')
{
var searchURL ="&Query="
}
else
{
var EncodedQueryValue = escape(QueryValue); //replace special characters
var searchURL = "&Query=" + EncodedQueryValue;
}
var TitleURL = ''
var TitleValue = document.forms[0].Title.value;
if (TitleValue == "")
 {
TitleURL = ''
} 
else
{
var EncodedTitleValue = escape(TitleValue); //replace special characters
if (searchURL == '&Query=')
	{
	searchURL = searchURL+ '[Title]=' + EncodedTitleValue;
	}
else
	{
	searchURL = searchURL + '+AND+[Title]=' + EncodedTitleValue;
	}
}

//  *************************************************
var QuestionURL = ''
var QuestionValue = document.forms[0].Question.value;
if (QuestionValue == "")
{
var QuestionURL = ''
}
else
{
var EncodedQuestionValue = escape(QuestionValue); //replace special characters
var QuestionURL = '[Question]=' + EncodedQuestionValue;

if (searchURL == '&Query=')
{
searchURL = searchURL+ '[Question]=' + EncodedQuestionValue;
}
else
{
searchURL = searchURL + '+AND+[Question]=' + EncodedQuestionValue;
}
}

//  *************************************************
var AgencyNameURL = ''
	var AgencyNameValue = document.forms[0].AgencyName.value;
	if (AgencyNameValue == "")
	 {
	AgencyNameURL = ''
	} 
	else
	{
	var EncodedAgencyNameValue = escape(AgencyNameValue); //replace special characters
	if (searchURL == '&Query=')
		{
		searchURL = searchURL+ '[AgencyName]=' + EncodedAgencyNameValue;
		}
	else
		{
		searchURL = searchURL + '+AND+[AgencyName]=' + EncodedAgencyNameValue;
		}
	}
//*************************************************
	var NonAgencyNameURL = ''
	var NonAgencyNameValue = document.forms[0].NonAgencyName.value
	if (NonAgencyNameValue == "")
	 {
	NonAgencyNameURL = ''
	} 
	else
	{
	var EncodedNonAgencyNameValue = escape(NonAgencyNameValue); //replace special characters
	if (searchURL == '&Query=')
		{
		searchURL = searchURL+ '[NonAgencyName]=' + EncodedNonAgencyNameValue;
		}
	else
		{
		searchURL = searchURL + '+AND+[NonAgencyName]=' + EncodedNonAgencyNameValue;
		}
	}

	// ******************************************************************
	var StatusURL = ''
		var StatusValue = document.forms[0].Status.value
		if (StatusValue == "")
		 {
			StatusURL = ''
		} 
		else
		{
		var EncodedStatusValue = escape(StatusValue); //replace special characters
		if (searchURL == '&Query=')
			{
			searchURL = searchURL+ '[Status]=' + EncodedStatusValue;
			}
		else
			{
			searchURL = searchURL + '+AND+[Status]=' + EncodedStatusValue;
			}
		}
	// ******************************************************************
	var PositionURL = ''
		var PositionValue = document.forms[0].Position.value
		if (PositionValue == "" || PositionValue == "<Select One>")
		 {
			PositionURL = ''
		} 
		else
		{
		var EncodedPositionValue = escape(PositionValue); //replace special characters
		if (searchURL == '&Query=')
			{
			searchURL = searchURL+ '[Position]=' + EncodedPositionValue;
			}
		else
			{
			searchURL = searchURL + '+AND+[Position]=' + EncodedPositionValue;
			}
		}

	// ******************************************************************
	var InteractionIDURL = ''
		var InteractionIDValue = document.forms[0].InteractionID.value
		if (InteractionIDValue == "" || InteractionIDValue == "<Select One>")
		 {
			InteractionIDURL = ''
		} 
		else
		{
		var EncodedInteractionIDValue = escape(InteractionIDValue); //replace special characters
		if (searchURL == '&Query=')
			{
			searchURL = searchURL+ '[InteractionID]=' + EncodedInteractionIDValue;
			}
		else
			{
			searchURL = searchURL + '+AND+[InteractionID]=' + EncodedInteractionIDValue;
			}
		}
	// ******************************************************************
	var ResponseURL = ''
		var ResponseValue = document.forms[0].Response.value
		if (ResponseValue == "")
		 {
			ResponseURL = ''
		} 
		else
		{
		var EncodedResponseValue = escape(ResponseValue); //replace special characters
		if (searchURL == '&Query=')
			{
			searchURL = searchURL+ '[Response]=' + EncodedResponseValue;
			}
		else
			{
			searchURL = searchURL + '+AND+[Response]=' + EncodedResponseValue;
			}
		}

	// ******************************************************************
	var CreatedByURL = ''
		var CreatedByValue = document.forms[0].CreatedBy.value
		if (CreatedByValue == "" || CreatedByValue == "<Select One>" )
		 {
			CreatedByURL = ''
		} 
		else
		{
		var EncodedCreatedByValue = escape(CreatedByValue); //replace special characters
		if (searchURL == '&Query=')
			{
			searchURL = searchURL+ '[CreatedBy]=' + EncodedCreatedByValue;
			}
		else
			{
			searchURL = searchURL + '+AND+[CreatedBy]=' + EncodedCreatedByValue;
			}
		}
	// ******************************************************************
	var AssignedURL = ''
	var AssignedValue = document.forms[0].Assigned.value
	var EncodedAssignedValue = escape(AssignedValue); //replace special characters
		if (AssignedValue == "")
		 {
			AssignedURL = ''
		 } 
		else
		 {
		 if (searchURL == '&Query=')
			{
			searchURL = searchURL+ '[Assigned]=' + EncodedAssignedValue;
			}
		 else
			{
			searchURL = searchURL + '+AND+[Assigned]=' + EncodedAssignedValue;
			}
		}
	// ******************************************************************

	// Categories

	var checkboxes = document.getElementsByName('Category');
	var vals = "";
	var j=0;
	for (var i=0, n=checkboxes.length;i<n;i++) 
	{
	  if (checkboxes[i].checked) 
	  	{
		  if(j==0)
			  {
			  vals = "[Category]=" +checkboxes[i].value; 
			  j=1;
			  }
		  else
		  	  {
			  vals = vals + "+OR+[Category]=" +checkboxes[i].value; 
			  }
		  vals == "(" +vals + ")";
	    }
	}
	if (searchURL == '&Query=')
	 	{
		searchURL = searchURL + vals ;
	 	}
	else
		{
		if (vals!=="")
			{
			searchURL = searchURL + '+AND+' + "(" + vals + ")";
			}
		}

	// ******************************************************************
	//CREATEDATE: test for 2 values - From and To. if one then get operator or default to > 
	var FromValue = document.forms[0].From.value
	var EncodedFromValue = escape(FromValue); //replace special characters
	
	var ToURL = ''
	var ToValue = document.forms[0].To.value
	var EncodedToValue = escape(ToValue); //replace special characters
	var op = document.forms[0].FromOperator.value
	var cd = EncodedFromValue.concat(EncodedToValue);
	var n = cd.length;
	if (n > 0)
	{
		if (EncodedFromValue == "" || EncodedToValue == "" )
		// doing single with operator
			{
				var dtval = op + EncodedFromValue.concat(EncodedToValue)
				if (searchURL == '&Query=')
				{
					searchURL = searchURL+ '[InitiationDate]' + dtval;
				}
				else
				{
					searchURL = searchURL + '+AND+[InitiationDate]' + dtval;
				}	
			}
		else
			//got a date range
			{
				if (searchURL == '&Query=')
				{
					searchURL = searchURL + '[InitiationDate]>' + EncodedFromValue + '+AND+' + '[InitiationDate]<' + EncodedToValue;
				}
				else
				{
					searchURL = searchURL+ '+AND+[InitiationDate]>' + EncodedFromValue + '+AND+'+'[InitiationDate]<' + EncodedToValue;
				}	
			}
	}
	
		//RESOLUTIONDATE: test for 2 values - From_1 and To_1. if one then get operator or default to > 
	var From_1Value = document.forms[0].From_1.value
	var EncodedFrom_1Value = escape(From_1Value); //replace special characters
	var To_1Value = document.forms[0].To_1.value
	var EncodedTo_1Value = escape(To_1Value); //replace special characters
	var op_1 = document.forms[0].FromOperator_1.value

	var cd_1 = EncodedFrom_1Value.concat(EncodedTo_1Value);
	var n_1 = cd_1.length;

	if (n_1 > 0)
	{
		if (From_1Value == "" || To_1Value == "" )
		// doing single with operator
		{
			var dtval_1 = op_1 + EncodedFrom_1Value.concat(EncodedTo_1Value)
			if (searchURL == '&Query=')
				{
				searchURL = searchURL+ '[ResolutionDate]' + dtval_1;
				}
			else
				{
				searchURL = searchURL + '+AND+[ResolutionDate]' + dtval_1;
				}	
		}
		else
				//got a date range
		{
			if (searchURL == '&Query=')
			{
				searchURL = searchURL + '[ResolutionDate]>' + EncodedFrom_1Value + '+AND+' + '[ResolutionDate]<' + EncodedTo_1Value;
			}
			else
			{
				searchURL = searchURL+ '+AND+[ResolutionDate]>' + EncodedFrom_1Value + '+AND+'+'[ResolutionDate]<' + EncodedTo_1Value;
			}	
		}
	}
	
// **************************************************************************************
	var SearchOrderValue = document.forms[0].SearchOrder.value;  //Optional. 1 is Domino Default, therefore returning blank string if  not checked
	if (SearchOrderValue == 1)
		{
		var SearchOrderURL = ''
		}
	else
		{
		var SearchOrderURL = '&SearchOrder=' + SearchOrderValue
		var optionsURL = '&SearchMax=0&SearchWV=TRUE' + SearchOrderURL;
		}

searchURL = DbPathURL + ViewNameURL + searchURL + SearchOrderURL;
var res = searchURL.replace("&","+AND+");
res = res.replace("+AND+Query","&Query");
document._searchint["GeneratedURL"].value=res;
window.location.href = res;
}

