// Required Modules
const https = require('https');
const querystring = require('querystring');
const cheerio = require('cheerio');
const { performance } = require('perf_hooks');
const notifier = require('node-notifier');

// Custom HTTPS Agent Configuration
const httpsAgent = new https.Agent({
  rejectUnauthorized: false, // Disable SSL certificate verification
  keepAlive: true,           // Enable keep-alive for persistent connections
  maxSockets: 50,            // Maximum number of sockets per host
  maxFreeSockets: 10,        // Maximum number of free sockets per host
});

// Function to Extract and Merge Cookies from Response Headers
function extractAndMergeCookies(headers, currentCookies) {
  const setCookies = headers['set-cookie'];
  if (setCookies) {
    const newCookies = setCookies.map(cookie => cookie.split(';')[0]);
    const cookieMap = new Map(
      (currentCookies || '')
        .split('; ')
        .filter(Boolean)
        .map(cookie => {
          const index = cookie.indexOf('=');
          return [cookie.slice(0, index), cookie.slice(index + 1)];
        })
    );
    newCookies.forEach(cookie => {
      const index = cookie.indexOf('=');
      const key = cookie.slice(0, index);
      const value = cookie.slice(index + 1);
      cookieMap.set(key, value);
    });
    return Array.from(cookieMap.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
  }
  return currentCookies || '';
}

// Function to Perform Login Automation
async function automateLogin({r,p}, ipAddress) {
  const got = (await import('got')).default;

  try {
    let cookies = "";

    // Step 1: GET `/` to retrieve initial cookies (e.g., `connect.sid`)
    let response = await got(`https://${ipAddress}/`, {
      method: 'GET',
      headers: getCommonHeaders(),
      responseType: 'text',
      agent: { https: httpsAgent },
      followRedirect: false,
      throwHttpErrors: false,
    });

    // Merge cookies from the initial response
    cookies = extractAndMergeCookies(response.headers, cookies);
    console.log('Step 1: Retrieved initial cookies:', cookies);

    // Step 2: POST `/student/login` with credentials to retrieve `token`
    const credentials = querystring.stringify({
      roll_no: r,
      password: p,
    });

    response = await got(`https://${ipAddress}/student/login`, {
      method: 'POST',
      body: credentials,
      headers: {
        "Host" : "reg.exam.dtu.ac.in",
        "Cache-Control": "max-age=0",
        "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
        "Origin": "https://reg.exam.dtu.ac.in",
        "Content-Type": "application/x-www-form-urlencoded",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-User": "?1",
        "Sec-Fetch-Dest": "document",
        "Referer" : "https://reg.exam.dtu.ac.in/student/login",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Priority": "u=0, i",
        "Connection": "keep-alive",
        'Cookie': cookies,
        "DNT" : "1",
      },
      responseType: 'text',
      agent: {https: httpsAgent},
      followRedirect: false,
      throwHttpErrors: false,
    });

    console.log('Step 2: Login response status:', response.statusCode);
    console.log('Step 2: Login response location:', response.headers.location);
    cookies = extractAndMergeCookies(response.headers, cookies);
    console.log('Step 2: Retrieved token and updated cookies:', cookies);

    const location = response.headers.location;
    if (location && location.includes('/student/login')) {
      throw new Error('Invalid Roll Number or Password.');
    }

    let studentHash = "";
    if (location) {
      const locationMatch = location.match(/\/student\/home\/([^/?]+)/);
      if (locationMatch && locationMatch[1]) {
        studentHash = locationMatch[1];
        console.log('Extracted Student Hash from redirect:', studentHash);
      }
    }

    if (!studentHash) {
      const bodyMatch = response.body.match(/\/student\/home\/([^"'>\s]+)/);
      if (bodyMatch && bodyMatch[1]) {
        studentHash = bodyMatch[1];
        console.log('Extracted Student Hash from body:', studentHash);
      }
    }

    if (!studentHash) {
      const invalidIndicators = ['Invalid Roll No or Password', 'Invalid roll no', 'Invalid password', 'Invalid credentials', '/student/login'];
      const foundInvalid = invalidIndicators.some(indicator => response.body.includes(indicator));
      if (foundInvalid) {
        throw new Error('Invalid Roll Number or Password.');
      }
      if (response.statusCode === 302) {
        throw new Error(`Unexpected login redirect: ${location || 'no location header'}`);
      }
      throw new Error(`Could not extract student hash from login response. status=${response.statusCode}`);
    }

    return { cookies, studentHash };
  } catch (error) {
    console.error('Error during login:', error.message);
    throw error;
  }
}

async function automateLoginWithRetry(credentials, ipAddress, callbacks) {
  let attempts = 0;
  const delayTime = 10;

  while (isRunning) {
    try {
      attempts++;
      callbacks.onStatusUpdate(`Login attempt ${attempts}...`);
      const result = await automateLogin(credentials, ipAddress);
      callbacks.onStatusUpdate('Login successful.');
      return result;
    } catch (error) {
      if (!isRunning) {
        break;
      }
      if (error.message === 'Invalid Roll Number or Password.') {
        throw error; // Do not retry on invalid credentials
      }
      callbacks.onStatusUpdate(`Login failed: ${error.message}. Retrying in ${delayTime}ms...`);
      await delay(delayTime);
    }
  }
  throw new Error("Automation stopped during login.");
}

// Function to Fetch Course Registration HTML Content
async function fetchCourseRegHTML(cookies, studentHash, ipAddress) {
  const { default: got } = await import('got');

  try {
    const response = await got(`https://${ipAddress}/student/courseRegistration/${studentHash}`, {
      method: 'GET',
      headers: {
        ...getCommonHeaders(),
        'Referer': `https://reg.exam.dtu.ac.in/student/home/${studentHash}`,
        'Cookie': cookies,
      },
      agent: { https: httpsAgent },
      responseType: 'text',
      followRedirect: false,
    });

    if (response.statusCode !== 200) {
      throw new Error(`Failed to fetch course registration page. Status code: ${response.statusCode}`);
    }

    console.log('Fetched course registration page successfully.');
    // console.log(response.body);
    return response.body;
  } catch (error) {
    console.warn("Warning: Unable to fetch course registration HTML content.", error);
    return null;
  }
}

// Function to Fetch and Track Desired Courses
async function fetchTrackedCourses(cookies, studentHash, ipAddress, courseCodes) {
  const htmlContent = await fetchCourseRegHTML(cookies, studentHash, ipAddress);

  if (!htmlContent) {
    throw new Error("No HTML content fetched for course registration.");
  }

  try {
    const $ = cheerio.load(htmlContent);
    const trackedCourses = new Map();

    const parsedCourses = new Map(
      courseCodes.map(code => {
        const [courseCode, courseSlot] = code.split(":");
        if (!courseCode || !courseSlot) {
          throw new Error(`Invalid course entry: ${code}. Expected format COURSE_CODE:SECTION`);
        }
        return [courseCode.trim().toUpperCase(), courseSlot.trim().toUpperCase()];
      })
    );

    $("table tbody tr").each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length >= 4) {
        const courseCode = $(cells[1]).text().trim().toUpperCase();
        const courseSlot = $(cells[3]).text().trim().toUpperCase();
        const seats = parseInt($(cells[4]).text().trim().replace(/\D/g, ''), 10) || 0;
        const formAction = cells.length > 5 ? $(cells[5]).find("form").attr("action") : null;

        if (parsedCourses.has(courseCode) && parsedCourses.get(courseCode) === courseSlot) {
          const courseKey = `${courseCode}|${courseSlot}`;
          const courseHashMatch = formAction ? formAction.match(new RegExp(`/student/courseRegister/${studentHash}/([^/?]+)`)) : null;
          const courseHash = courseHashMatch ? courseHashMatch[1] : null;

          trackedCourses.set(courseKey, {
            courseCode,
            courseSlot,
            seats,
            courseHash,
          });
          parsedCourses.delete(courseCode);
          console.log(`Tracking Course: ${courseCode} (Slot: ${courseSlot}) with Hash: ${courseHash || 'pending'} and Seats: ${seats}`);
        }
      }
    });

    // Check for courses that were not found
    if (parsedCourses.size > 0) {
      const notFound = Array.from(parsedCourses.keys()).join(', ');
      throw new Error(`The following course(s) were not found: ${notFound}. Please check the course code and slot.`);
    }
    return trackedCourses;
  } catch (error) {
    console.error("Error processing courses:", error);
    throw error;
  }
}

// Function to Send POST Request for Course Registration
const sendPostReq = async (cookies, studentHash, ipAddress, courseHash, callbacks) => {
  const { default: got } = await import('got');

  try {
    const response = await got.post(`https://${ipAddress}/student/courseRegister/${studentHash}/${courseHash}`, {
      headers: {
        ...getCommonHeaders(),
        'Referer': `https://reg.exam.dtu.ac.in/student/courseRegistration/${studentHash}`,
        'Cookie': cookies,
        'Content-Length': '0',
      },
      responseType: 'text',
      agent: { https: httpsAgent },
      throwHttpErrors: false,
      followRedirect: false,
    });

    const status = response.statusCode;
    const location = response.headers.location || '';
    const body = response.body || '';
    const lowerBody = body.toLowerCase();

    callbacks.onStatusUpdate(`Registration request sent for ${courseHash} (status ${status}).`);
    console.log(`POST Request to register course ${courseHash} - Status Code: ${status}`);

    const successIndicators = [
      'successfully registered',
      'registered successfully',
      'registration successful',
      'you have successfully registered',
      'you are successfully enrolled',
      'enrolled successfully',
      'course registration successful',
      'course registered successfully',
    ];

    const failureIndicators = [
      'invalid',
      'error',
      'could not',
      'cannot',
      'already registered',
      'blocked',
      'not eligible',
      'session expired',
      'login',
    ];

    const bodyHasSuccess = successIndicators.some(text => lowerBody.includes(text));
    const bodyHasFailure = failureIndicators.some(text => lowerBody.includes(text));

    const success = (status === 302 && !location.includes('/student/login'))
      || bodyHasSuccess
      || (status === 200 && body.includes('alert-success'));

    if (success && bodyHasFailure && !bodyHasSuccess) {
      return { success: false, status, location, body };
    }

    return { success, status, location, body };
  } catch (error) {
    callbacks.onStatusUpdate(`Registration request error for ${courseHash}: ${error.message}`);
    console.error('Error sending POST request:', error.message);
    return { success: false, status: null, location: null, body: '' };
  }
};

let isRunning = false;

// Handler Logic to Monitor and Register Courses
const handlerLogic = async (session, ipAddress, trackedCourses, autoLogin, credentials, callbacks) => {
  const { default: got } = await import('got');
  let previousEtag = null;
  let currentSession = session;

  const sendGetReq = async () => {
    if (!isRunning) return null;
    try {
      const response = await got(`https://${ipAddress}/student/courseRegistration/${currentSession.studentHash}`, {
        method: 'GET',
        headers: {
          ...getCommonHeaders(),
          'Referer': `https://reg.exam.dtu.ac.in/student/home/${currentSession.studentHash}`,
          'Cookie': currentSession.cookies,
        },
        agent: { https: httpsAgent },
        responseType: 'text',
        followRedirect: false,
      });

      const currentEtag = response.headers['etag'];
      if (previousEtag && currentEtag === previousEtag) {
        callbacks.onStatusUpdate('No updates found (ETag unchanged).');
        return null;
      }
      callbacks.onStatusUpdate('New data fetched (ETag changed).');
      previousEtag = currentEtag;

      const $ = cheerio.load(response.body);

      if (response.body.length < 18000 && $('p').text().includes('Found. Redirecting to /student/login')) {
        throw new Error("Session Expired");
      }

      const alertDiv = $('div.alert.alert-danger.alert-dismissible.fade.show[role="alert"]');
      if (alertDiv.length > 0) {
        callbacks.onStatusUpdate(`Alert: ${alertDiv.text().trim()}`);
      }

        $("tr").each((_, element) => {
        const formAction = $(element).find("form[action*='/student/courseRegister/']").attr("action");
        const courseHashMatch = formAction?.match(/\/student\/courseRegister\/[^/]+\/([^/?]+)/);
        if (!courseHashMatch) return;

        const courseHash = courseHashMatch[1];
        const trackedEntry = Array.from(trackedCourses.entries()).find(([, data]) => data.courseHash === courseHash);
        if (!trackedEntry) return;

        const [courseKey, trackedCourse] = trackedEntry;
        const row = $(element);
        const rowText = row.text().toLowerCase();
        if (rowText.includes('blocked') || row.attr('bgcolor') === '#d4d3d2') {
          trackedCourses.delete(courseKey);
          callbacks.onCourseBlocked(trackedCourse);
          callbacks.onStatusUpdate(`Course is Blocked: ${trackedCourse.courseCode} - Dropping from tracking.`);
        }
      });

      return $;
    } catch (error) {
      if (!isRunning) throw error;

      if (autoLogin && error.message.includes("Session Expired")) {
        callbacks.onStatusUpdate("Session expired. Attempting to re-login...");
        try {
          currentSession = await automateLoginWithRetry(credentials, ipAddress, callbacks);
          callbacks.onStatusUpdate("Session re-initiated successfully.");
        } catch (loginError) {
          callbacks.onError(loginError.message);
          throw loginError; // Stop if relogin fails (e.g., invalid credentials)
        }
        return null; // Retry the GET request with the new session
      }

      // Handle HTTP errors (e.g., 404, 5xx) by retrying
      if (error.response && error.response.statusCode) {
        callbacks.onStatusUpdate(`Request failed with status ${error.response.statusCode}. Retrying...`);
        return null; // Returning null will cause a retry after 900ms in the main loop
      }

      // Handle other errors (e.g., network issues)
      callbacks.onError(`An unexpected error occurred: ${error.message}. Retrying...`);
      return null; // Returning null will cause a retry
    }
  };

  const checkAndRegister = async () => {
    while (isRunning) {
      const $ = await sendGetReq();
      if (!$) {
        await delay(900);
        continue;
      }

      const slotsToTrack = groupCoursesBySlot(trackedCourses);
      let registeredSomething = false;

      for (const [courseSlot, courses] of slotsToTrack.entries()) {
        if (!isRunning) return;
        const slotHeader = $(`tr.setHeader td[colspan="3"]:contains(${courseSlot})`);
        if (slotHeader.length === 0) continue;

        const slotRows = gatherSlotRows(slotHeader);

        for (const row of slotRows) {
          if (!isRunning) return;
          const cells = $(row).find("td");
          const courseCode = $(cells[1]).text().trim().toUpperCase();
          const courseSlotText = $(cells[3]).text().trim().toUpperCase();
          const courseKey = `${courseCode}|${courseSlotText}`;
          const courseData = trackedCourses.get(courseKey);

          if (courseData) {
            const newSeats = parseInt($(cells[4]).text().trim().replace(/\D/g, ''), 10) || 0;

            if (newSeats !== courseData.seats) {
              const updatedCourseData = { ...courseData, seats: newSeats };
              trackedCourses.set(courseKey, updatedCourseData);
              callbacks.onStatusUpdate(`Seat Update: ${courseCode} (${courseData.courseSlot}) - Seats: ${courseData.seats} -> ${newSeats}`);
            }

            const formAction = cells.length > 5 ? $(cells[5]).find("form").attr("action") : null;
            if (!courseData.courseHash && formAction) {
              const courseHashMatch = formAction.match(/\/student\/courseRegister\/[^/]+\/([^/?]+)/);
              if (courseHashMatch) {
                courseData.courseHash = courseHashMatch[1];
                trackedCourses.set(courseKey, courseData);
                callbacks.onStatusUpdate(`Registration opened for ${courseCode}. Course hash acquired.`);
              }
            }

            if (newSeats > 0 && courseData.courseHash) {
              const result = await sendPostReq(currentSession.cookies, currentSession.studentHash, ipAddress, courseData.courseHash, callbacks);
              callbacks.onStatusUpdate(`Attempting to register for ${courseCode}...`);
              if (result.success) {
                trackedCourses.delete(courseKey);
                callbacks.onCourseRegistered(courseData);
                callbacks.onStatusUpdate(`Course registered successfully: ${courseCode} (${courseSlotText}).`);
              } else {
                callbacks.onStatusUpdate(`Registration request may have failed for ${courseCode}. Retrying later.`);
              }
              registeredSomething = true;
              break;
            }
          }
        }
        if (registeredSomething) break;
      }

      if (registeredSomething) {
        await delay(1000);
        continue;
      }

      if (trackedCourses.size === 0) {
        callbacks.onStatusUpdate('All courses have been registered. Stopping automation.');
        break;
      }

      await delay(900);
    }
  };

  await checkAndRegister();
};

// Utility Function to Get Common Headers
function getCommonHeaders() {
  return {
    "Host": "reg.exam.dtu.ac.in",
    "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_  A Brand";v="24"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-User": "?1",
    "Sec-Fetch-Dest": "document",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Priority": "u=0, i",
    "Connection": "keep-alive",
    "DNT": "1",
  };
}

// Utility Function to Delay Execution
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Utility Function to Group Courses by Slot
function groupCoursesBySlot(trackedCourses) {
  const slotsToTrack = new Map();
  for (const [courseHash, { courseCode, courseSlot, seats }] of trackedCourses.entries()) {
    if (!slotsToTrack.has(courseSlot)) {
      slotsToTrack.set(courseSlot, []);
    }
    slotsToTrack.get(courseSlot).push({ courseHash, courseCode, seats });
  }
  return slotsToTrack;
}

// Utility Function to Gather Rows Under a Slot Header
function gatherSlotRows(slotHeader) {
  const slotRows = [];
  let currentRow = slotHeader.parent().next();
  while (currentRow.length > 0) {
    if (currentRow.hasClass("setHeader")) break;
    slotRows.push(currentRow[0]);
    currentRow = currentRow.next();
  }
  return slotRows;
}

// Main Execution Function
async function startAutomation(credentials, ipAddress, courseIdsToTrack, autoLogin, callbacks) {
  isRunning = true;
  try {
    let session;
    if (autoLogin) {
      session = await automateLoginWithRetry(credentials, ipAddress, callbacks);
    } else {
      callbacks.onStatusUpdate('Attempting to log in...');
      session = await automateLogin(credentials, ipAddress);
    }

    callbacks.onStatusUpdate('Login successful. Fetching courses...');
    const trackedCourses = await fetchTrackedCourses(session.cookies, session.studentHash, ipAddress, courseIdsToTrack);

    if (trackedCourses.size === 0) {
      throw new Error("No courses to track. They may already be registered or the list is empty.");
    }
    
    if (!isRunning) return;

    callbacks.onStatusUpdate(`Now tracking ${trackedCourses.size} course(s). Monitoring for seat availability...`);
    await handlerLogic(session, ipAddress, trackedCourses, autoLogin, credentials, callbacks);
  } catch (error) {
    callbacks.onError(error.message);
  } finally {
    isRunning = false;
    if (callbacks && callbacks.onStop) {
      callbacks.onStop();
    }
  }
}

function stopAutomation() {
  if (isRunning) {
    isRunning = false;
  }
}

module.exports = { startAutomation, stopAutomation };
